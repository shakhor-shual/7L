package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

//go:embed static/*
var staticFS embed.FS

type Config struct {
	Name        string            `json:"name"`
	Runtime     string            `json:"runtime,omitempty"`
	Description string            `json:"description,omitempty"`
	Args        []string          `json:"args"`
	Env         map[string]string `json:"env,omitempty"`
	DefaultCtx  int               `json:"default_ctx,omitempty"`
	LastUsed    int64             `json:"last_used,omitempty"`
}

type configFile struct {
	GlobalRuntime string   `json:"global_runtime,omitempty"`
	HfCache       string   `json:"hf_cache,omitempty"`
	Configs       []Config `json:"configs"`
}

type ConfigResponse struct {
	Config
	ArgsStr string `json:"args_str"`
	EnvStr  string `json:"env_str"`
	Running bool   `json:"running"`
	Ready   bool   `json:"ready"`
	CtxSize int    `json:"ctx_size"`
	Pid     int    `json:"pid"`
	Uptime  int    `json:"uptime"`
	Port    int    `json:"port"`
}

type process struct {
	cmd       *exec.Cmd
	ptyFile   *os.File
	cfg       RuntimeConfig
	startedAt time.Time
	ready     chan struct{}
	finished  chan struct{}
}

type RuntimeConfig struct {
	Config
	CtxSize int `json:"ctx_size"`
}

var (
	configs       []Config
	globalRuntime string
	globalHfCache string
	procs         sync.Map
)

var (
	flagLlamaBin  string
	flagPort      int
	flagConfig    string
	flagHost      string
	flagLogLevel  string
	flagNoBrowser bool
)

func main() {
	flag.StringVar(&flagLlamaBin, "llama-bin", "", "llama.cpp binary path (overrides LLAMA_BIN)")
	flag.IntVar(&flagPort, "port", 0, "Web interface port (overrides PORT)")
	flag.StringVar(&flagConfig, "config", "", "Model config file path (default: config.json)")
	flag.StringVar(&flagHost, "host", "", "Host to bind (default: all interfaces)")
	flag.StringVar(&flagLogLevel, "log-level", "", "Log level: debug, info, warn, error (default: info)")
	flag.BoolVar(&flagNoBrowser, "no-browser", false, "Don't open browser on start")

	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "7L — manage llama.cpp via web interface\n\n")
		fmt.Fprintf(os.Stderr, "Usage: %s [options]\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "Options:\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nEnvironment variables:\n")
		fmt.Fprintf(os.Stderr, "  LLAMA_BIN    llama.cpp binary path (if --llama-bin not set)\n")
		fmt.Fprintf(os.Stderr, "  PORT         Web interface port (if --port not set)\n")
		fmt.Fprintf(os.Stderr, "\nExamples:\n")
		fmt.Fprintf(os.Stderr, "  %s --llama-bin /opt/llama/llama-cli --port 9090\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  %s --config ./my-models.json --log-level debug\n", os.Args[0])
	}
	flag.Parse()

	applySettings()
	loadConfigs()

	mux := http.NewServeMux()
	sub, _ := fs.Sub(staticFS, "static")
	mux.Handle("/", http.FileServer(http.FS(sub)))
	mux.HandleFunc("/api/configs", getConfigs)
	mux.HandleFunc("/api/config/update", handleConfigUpdate)
	mux.HandleFunc("/api/global-config", handleGlobalConfig)
	mux.HandleFunc("/api/global-config/update", handleGlobalConfigUpdate)
	mux.HandleFunc("/api/run", handleRun)
	mux.HandleFunc("/api/stop", handleStop)
	mux.HandleFunc("/logs/", handleLogs)
	mux.HandleFunc("/api/browse", handleBrowse)
	mux.HandleFunc("/api/stat", handleStat)
	mux.HandleFunc("/api/params", handleParams)
	mux.HandleFunc("/api/card/create", handleCardCreate)
	mux.HandleFunc("/api/card/delete", handleCardDelete)
	mux.HandleFunc("/api/card/rename", handleCardRename)
	mux.HandleFunc("/api/gpu-info", handleGPUInfo)
	mux.HandleFunc("/api/os", handleOS)
	mux.HandleFunc("/api/mkdir", handleMkdir)
	mux.HandleFunc("/api/parse-command", handleParseCommand)
	mux.HandleFunc("/api/wizard/save", handleWizardSave)
	mux.HandleFunc("/api/first-run", handleFirstRun)
	mux.HandleFunc("/api/first-run/setup", handleFirstRunSetup)
	mux.HandleFunc("/api/first-run/smart-scan", handleSmartScan)

	addr := fmt.Sprintf("%s:%d", flagHost, flagPort)
	llamaBin := findLlamaBinary()

	log.Printf("🔧 llama binary: %s", llamaBin)
	log.Printf("📋 Config: %s", flagConfig)
	log.Printf("🚀 7L started on http://%s", addr)

	if !flagNoBrowser {
		go openBrowser(fmt.Sprintf("http://localhost:%d", flagPort))
	}

	log.Fatal(http.ListenAndServe(addr, mux))
}

func applySettings() {
	if flagPort == 0 {
		if envPort := os.Getenv("PORT"); envPort != "" {
			if p, err := strconv.Atoi(envPort); err == nil {
				flagPort = p
			}
		}
		if flagPort == 0 {
			flagPort = 7777
		}
	}

	if flagConfig == "" {
		if envConfig := os.Getenv("LLAMA_CONFIG"); envConfig != "" {
			flagConfig = envConfig
		} else {
			flagConfig = "config.json"
		}
	}

	if flagHost == "" {
		if envHost := os.Getenv("LLAMA_HOST"); envHost != "" {
			flagHost = envHost
		}
	}

	if flagLogLevel == "" {
		if envLog := os.Getenv("LLAMA_LOG_LEVEL"); envLog != "" {
			flagLogLevel = envLog
		} else {
			flagLogLevel = "info"
		}
	}

	switch flagLogLevel {
	case "debug":
		log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	case "warn", "error":
		log.SetFlags(0)
	default:
		log.SetFlags(log.Ldate | log.Ltime)
	}
}

func findLlamaBinary() string {
	if flagLlamaBin != "" {
		return flagLlamaBin
	}
	if globalRuntime != "" {
		return globalRuntime
	}
	if env := os.Getenv("LLAMA_BIN"); env != "" {
		return env
	}
	return "llama.cpp"
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch {
	case strings.Contains(os.Getenv("OS"), "Windows"):
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case strings.Contains(os.Getenv("XDG_SESSION_TYPE"), "wayland") ||
		strings.Contains(os.Getenv("XDG_SESSION_TYPE"), "x11"):
		cmd = exec.Command("xdg-open", url)
	case strings.Contains(os.Getenv("TERM_PROGRAM"), "Apple_Terminal"):
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("⚠️ Could not open browser: %v", err)
	}
}

func getConfigs(w http.ResponseWriter, _ *http.Request) {
	result := make([]ConfigResponse, 0, len(configs))
	for _, cfg := range configs {
		resp := ConfigResponse{
			Config:  cfg,
			ArgsStr: argsToString(cfg.Args),
			EnvStr:  envToString(cfg.Env),
			Running: false,
			Port:    extractPort(cfg.Args),
		}
		if val, ok := procs.Load(cfg.Name); ok {
			p := val.(*process)
			select {
			case <-p.finished:
			default:
				resp.Running = true
				select {
				case <-p.ready:
					resp.Ready = true
				default:
				}
				resp.CtxSize = p.cfg.CtxSize
				resp.Pid = p.cmd.Process.Pid
				resp.Uptime = int(time.Since(p.startedAt).Seconds())
			}
		}
		result = append(result, resp)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func argsToString(args []string) string {
	var b strings.Builder
	for i, arg := range args {
		if i > 0 {
			b.WriteByte(' ')
		}
		if strings.ContainsAny(arg, " \t\"") || arg == "" {
			b.WriteByte('"')
			b.WriteString(strings.ReplaceAll(arg, "\"", "\\\""))
			b.WriteByte('"')
		} else {
			b.WriteString(arg)
		}
	}
	return b.String()
}

func extractPort(args []string) int {
	for i, a := range args {
		if a == "--port" && i+1 < len(args) {
			if p, err := strconv.Atoi(args[i+1]); err == nil {
				return p
			}
		}
		if strings.HasPrefix(a, "--port=") {
			if p, err := strconv.Atoi(a[7:]); err == nil {
				return p
			}
		}
	}
	return 8080
}

func envToString(env map[string]string) string {
	if len(env) == 0 {
		return ""
	}
	var b strings.Builder
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(env[k])
	}
	return b.String()
}

func parseEnvString(s string) map[string]string {
	env := make(map[string]string)
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		key := strings.TrimSpace(parts[0])
		if key == "" {
			continue
		}
		if len(parts) == 2 {
			env[key] = strings.TrimSpace(parts[1])
		} else {
			env[key] = ""
		}
	}
	return env
}

func parseArgsString(s string) ([]string, error) {
	var args []string
	var cur strings.Builder
	inQuote := false
	escaped := false

	for _, r := range s {
		if escaped {
			cur.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' && inQuote {
			escaped = true
			continue
		}
		if r == '"' {
			inQuote = !inQuote
			continue
		}
		if !inQuote && (r == ' ' || r == '\t') {
			if cur.Len() > 0 {
				args = append(args, cur.String())
				cur.Reset()
			}
			continue
		}
		cur.WriteRune(r)
	}
	if cur.Len() > 0 {
		args = append(args, cur.String())
	}
	if inQuote {
		return nil, fmt.Errorf("unterminated quote")
	}
	return args, nil
}

func handleConfigUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	r.ParseForm()
	name := r.FormValue("name")
	argsStr := r.FormValue("args_str")
	envStr := r.FormValue("env_str")
	descStr := r.FormValue("description")
	ctxStr := r.FormValue("default_ctx")

	cfg := getConfigByName(name)
	if cfg == nil {
		http.Error(w, "Config not found", 404)
		return
	}

	if argsStr != "" {
		args, err := parseArgsString(argsStr)
		if err != nil {
			http.Error(w, fmt.Sprintf("Invalid args: %v", err), 400)
			return
		}
		cfg.Args = args
	}

	if r.Form.Has("env_str") {
		cfg.Env = parseEnvString(envStr)
	}

	if r.Form.Has("description") {
		cfg.Description = descStr
	}

	if r.Form.Has("runtime") {
		cfg.Runtime = r.FormValue("runtime")
	}

	if ctxStr != "" {
		if ctx, err := strconv.Atoi(ctxStr); err == nil && ctx > 0 {
			cfg.DefaultCtx = ctx
		}
	}

	if err := saveConfigs(); err != nil {
		log.Printf("⚠️ Config save error: %v", err)
		http.Error(w, fmt.Sprintf("Save error: %v", err), 500)
		return
	}

	log.Printf("💾 Config %s updated", cfg.Name)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleGlobalConfig(w http.ResponseWriter, r *http.Request) {
	effective := globalRuntime
	if flagLlamaBin != "" {
		effective = flagLlamaBin
	} else if effective == "" {
		if env := os.Getenv("LLAMA_BIN"); env != "" {
			effective = env
		} else {
			effective = "llama.cpp"
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"global_runtime":     globalRuntime,
		"hf_cache":           globalHfCache,
		"llama_bin_override": flagLlamaBin != "",
		"effective_runtime":  effective,
	})
}

func handleGlobalConfigUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	r.ParseForm()
	if r.Form.Has("runtime") {
		globalRuntime = r.FormValue("runtime")
		for i := range configs {
			if configs[i].Runtime == globalRuntime {
				configs[i].Runtime = ""
			}
		}
	}
	if r.Form.Has("hf_cache") {
		globalHfCache = r.FormValue("hf_cache")
	}
	if err := saveConfigs(); err != nil {
		log.Printf("⚠️ Global config save error: %v", err)
		http.Error(w, fmt.Sprintf("Save error: %v", err), 500)
		return
	}
	log.Printf("💾 Global config saved: runtime=%s hf_cache=%s", orDefault(globalRuntime, "<unset>"), orDefault(globalHfCache, "<unset>"))
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func saveConfigs() error {
	cf := configFile{
		GlobalRuntime: globalRuntime,
		HfCache:       globalHfCache,
		Configs:       configs,
	}
	data, err := json.MarshalIndent(cf, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(flagConfig, data, 0644)
}

func handleRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	r.ParseForm()
	name := r.FormValue("name")

	cfg := getConfigByName(name)
	if cfg == nil {
		http.Error(w, "Config not found", 404)
		return
	}
	if val, loaded := procs.Load(name); loaded {
		p := val.(*process)
		select {
		case <-p.finished:
			procs.Delete(name)
		default:
			http.Error(w, "Already running", 409)
			return
		}
	}

	ctxSize := 2048
	if s := r.FormValue("ctx_size"); s != "" {
		if parsed, err := strconv.Atoi(s); err == nil && parsed > 0 {
			ctxSize = parsed
		}
	}

	fullArgs := make([]string, 0, len(cfg.Args)+2)
	hasCtx := false
	for i, a := range cfg.Args {
		if a == "--ctx-size" || a == "-c" {
			hasCtx = true
			if i+1 < len(cfg.Args) && !strings.HasPrefix(cfg.Args[i+1], "-") {
				fullArgs = append(fullArgs, a, strconv.Itoa(ctxSize))
				continue
			}
		}
		if i > 0 && (cfg.Args[i-1] == "--ctx-size" || cfg.Args[i-1] == "-c") {
			continue
		}
		if strings.HasPrefix(a, "--ctx-size=") || strings.HasPrefix(a, "-c=") {
			hasCtx = true
			fullArgs = append(fullArgs, "--ctx-size="+strconv.Itoa(ctxSize))
			continue
		}
		fullArgs = append(fullArgs, a)
	}
	if !hasCtx {
		fullArgs = append(fullArgs, "--ctx-size", strconv.Itoa(ctxSize))
	}

	llamaBin := cfg.Runtime
	if llamaBin == "" {
		llamaBin = findLlamaBinary()
	}
	log.Printf("🔍 Starting: %s %s (PTY)", llamaBin, strings.Join(fullArgs, " "))

	cmd := exec.Command(llamaBin, fullArgs...)
	cmd.Env = os.Environ()
	if hasHfRepoFlag(fullArgs) {
		hasHfCache := false
		for _, e := range cmd.Env {
			if strings.HasPrefix(e, "HF_HUB_CACHE=") {
				hasHfCache = true
				break
			}
		}
		if !hasHfCache {
			cacheDir := resolveHfCache("")
			os.MkdirAll(cacheDir, 0755)
			cmd.Env = append(cmd.Env, "HF_HUB_CACHE="+cacheDir)
		}
	}
	for k, v := range cfg.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}

	ptyFile, err := pty.Start(cmd)
	if err != nil {
		http.Error(w, fmt.Sprintf("Error starting process: %v", err), 500)
		return
	}

	ready := make(chan struct{})
	proc := &process{
		cmd:       cmd,
		ptyFile:   ptyFile,
		startedAt: time.Now(),
		ready:     ready,
		finished:  make(chan struct{}),
		cfg: RuntimeConfig{
			Config:  *cfg,
			CtxSize: ctxSize,
		},
	}
	procs.Store(name, proc)

	cfg.LastUsed = time.Now().Unix()
	if err := saveConfigs(); err != nil {
		log.Printf("⚠️ Failed to save config after run: %v", err)
	}

	go func() {
		port := extractPort(cfg.Args)
		url := fmt.Sprintf("http://127.0.0.1:%d/health", port)
		client := &http.Client{Timeout: 2 * time.Second}
		ticker := time.NewTicker(300 * time.Millisecond)
		defer ticker.Stop()
		timeout := time.After(120 * time.Second)
		for {
			select {
			case <-ticker.C:
				resp, err := client.Get(url)
				if err == nil {
					resp.Body.Close()
					if resp.StatusCode == 200 {
						close(ready)
						return
					}
				}
			case <-timeout:
				close(ready)
				return
			}
		}
	}()

	go func() {
		time.Sleep(1 * time.Second)
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			log.Printf("❌ Process %s crashed on start (code: %d)", name, cmd.ProcessState.ExitCode())
		}
	}()

	go func() {
		cmd.Wait()
		log.Printf("🛑 Process %s finished (code: %d)", name, cmd.ProcessState.ExitCode())
		close(proc.finished)
		time.Sleep(5 * time.Second)
		proc.ptyFile.Close()
		procs.Delete(name)
	}()

	log.Printf("▶ Started %s (ctx=%d, pid=%d)", name, ctxSize, cmd.Process.Pid)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	fmt.Fprintf(w, `{"status":"ok","msg":"Started %s with ctx_size=%d, pid=%d"}`, name, ctxSize, cmd.Process.Pid)
}

func handleStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	r.ParseForm()
	name := r.FormValue("name")
	val, ok := procs.Load(name)
	if !ok {
		http.Error(w, "Process not running", 404)
		return
	}
	proc := val.(*process)
	proc.cmd.Process.Kill()

	select {
	case <-proc.finished:
	case <-time.After(3 * time.Second):
		log.Printf("⚠️ Timeout waiting for %s to stop", name)
	}

	log.Printf("⏹ Stopped %s", name)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	fmt.Fprintf(w, `{"status":"ok","msg":"Stopped"}`)
}

func handleLogs(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/logs/")
	val, ok := procs.Load(name)
	if !ok {
		http.Error(w, "Process not running", 404)
		return
	}
	proc := val.(*process)

	select {
	case <-proc.finished:
		http.Error(w, "Process already finished", 410)
		return
	default:
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming not supported", 500)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(200)
	flusher.Flush()

	fmt.Fprintf(w, "data: {\"type\":\"connected\",\"msg\":\"Logs connected\"}\n\n")
	flusher.Flush()

	ctx := r.Context()
	var wg sync.WaitGroup

	streamPTY := func() {
		defer wg.Done()
		var partial bytes.Buffer
		const (
			stNormal = iota
			stESC
			stCSI
			stOSC
		)
		escState := stNormal
		buf := make([]byte, 4096)
		for {
			select {
			case <-ctx.Done():
				if partial.Len() > 0 {
					fmt.Fprintf(w, "data: %s\n\n", partial.String())
				}
				return
			default:
			}
			n, err := proc.ptyFile.Read(buf)
			if n > 0 {
				for _, b := range buf[:n] {
					if b == 0x1b {
						escState = stESC
						continue
					}
					switch escState {
					case stESC:
						if b == '[' {
							escState = stCSI
						} else if b == ']' {
							escState = stOSC
						} else {
							escState = stNormal
						}
						continue
					case stCSI:
						if (b >= '0' && b <= '9') || b == ';' || b == '?' {
							continue
						}
						escState = stNormal
						if (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') {
							continue
						}
						continue
					case stOSC:
						if b == 0x07 {
							escState = stNormal
						} else if b == 0x1b {
							escState = stESC
						}
						continue
					}
					if b == '\n' || b == '\r' {
						if partial.Len() > 0 {
							fmt.Fprintf(w, "data: %s\n\n", partial.String())
							flusher.Flush()
						}
						partial.Reset()
					} else {
						partial.WriteByte(b)
					}
				}
			}
			if err != nil {
				if partial.Len() > 0 {
					fmt.Fprintf(w, "data: %s\n\n", partial.String())
					flusher.Flush()
				}
				return
			}
		}
	}

	wg.Add(1)
	go streamPTY()
	wg.Wait()

	fmt.Fprintf(w, "data: {\"type\":\"finished\",\"msg\":\"Process finished\"}\n\n")
	flusher.Flush()
}

var (
	paramsOnce   sync.Once
	cachedParams []paramInfo
)

type paramInfo struct {
	Flag  string   `json:"flag"`  // primary long flag for insertion
	Flags []string `json:"flags"` // all aliases for display
	Desc  string   `json:"desc"`
}

func handleParams(w http.ResponseWriter, r *http.Request) {
	paramsOnce.Do(func() {
		llamaBin := findLlamaBinary()
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, llamaBin, "--help")
		out, err := cmd.Output()
		if err != nil {
			log.Printf("⚠️ params help failed: %v", err)
			return
		}
		var currentFlags []string
		var currentShort string
		var currentDesc string
		flagRe := regexp.MustCompile(`--[\w-]+`)
		shortRe := regexp.MustCompile(`^(-\w+),\s*`)
		contRe := regexp.MustCompile(`^\s{35,}`)
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimRight(line, "\r")
			if line == "" || strings.HasPrefix(line, "-----") {
				continue
			}
			// Extract short flag (e.g. "-m"), then strip it
			shortM := shortRe.FindStringSubmatch(line)
			var shortFlag string
			var trimmed string
			if shortM != nil {
				shortFlag = shortM[1]
				trimmed = shortRe.ReplaceAllString(line, "")
			} else {
				trimmed = line
			}
			// Split flags from description by 2+ spaces
			var flagLine, descPart string
			if idx := strings.Index(trimmed, "  "); idx >= 0 {
				flagLine = trimmed[:idx]
				descPart = strings.TrimSpace(trimmed[idx+2:])
			} else {
				flagLine = trimmed
				descPart = ""
			}
			longFlags := flagRe.FindAllString(flagLine, -1)
			if len(longFlags) > 0 {
				if currentFlags != nil {
					allFlags := currentFlags
					if currentShort != "" {
						allFlags = append([]string{currentShort}, allFlags...)
					}
					cachedParams = append(cachedParams, paramInfo{Flag: currentFlags[0], Flags: allFlags, Desc: strings.TrimSpace(currentDesc)})
				}
				currentFlags = longFlags
				currentShort = shortFlag
				currentDesc = descPart
			} else if contRe.MatchString(line) && currentFlags != nil {
				text := strings.TrimSpace(line)
				if text != "" && !strings.HasPrefix(text, "(") {
					currentDesc += " " + text
					currentDesc = strings.TrimSpace(currentDesc)
				}
			}
		}
		if currentFlags != nil {
			allFlags := currentFlags
			if currentShort != "" {
				allFlags = append([]string{currentShort}, allFlags...)
			}
			cachedParams = append(cachedParams, paramInfo{Flag: currentFlags[0], Flags: allFlags, Desc: strings.TrimSpace(currentDesc)})
		}
		log.Printf("📋 Parsed %d params from %s --help", len(cachedParams), llamaBin)
	})
	if cachedParams == nil {
		http.Error(w, "Failed to load params", 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cachedParams)
}

func handleCardCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	r.ParseForm()
	name := r.FormValue("name")
	if name == "" {
		http.Error(w, "Name required", 400)
		return
	}
	for _, cfg := range configs {
		if cfg.Name == name {
			http.Error(w, "Name already exists", 409)
			return
		}
	}
	configs = append(configs, Config{
		Name:       name,
		Args:       []string{},
		DefaultCtx: 2048,
	})
	if err := saveConfigs(); err != nil {
		http.Error(w, fmt.Sprintf("Save error: %v", err), 500)
		return
	}
	log.Printf("➕ Card created: %s", name)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleCardDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	r.ParseForm()
	name := r.FormValue("name")
	if val, ok := procs.Load(name); ok {
		val.(*process).cmd.Process.Kill()
		procs.Delete(name)
	}
	idx := -1
	for i, cfg := range configs {
		if cfg.Name == name {
			idx = i
			break
		}
	}
	if idx < 0 {
		http.Error(w, "Not found", 404)
		return
	}
	configs = append(configs[:idx], configs[idx+1:]...)
	if err := saveConfigs(); err != nil {
		http.Error(w, fmt.Sprintf("Save error: %v", err), 500)
		return
	}
	log.Printf("🗑️ Card deleted: %s", name)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleCardRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	r.ParseForm()
	name := r.FormValue("name")
	newName := r.FormValue("new_name")
	if newName == "" {
		http.Error(w, "New name required", 400)
		return
	}
	for _, cfg := range configs {
		if cfg.Name == newName {
			http.Error(w, "Name already exists", 409)
			return
		}
	}
	for i := range configs {
		if configs[i].Name == name {
			configs[i].Name = newName
			if val, ok := procs.Load(name); ok {
				procs.Store(newName, val)
				procs.Delete(name)
			}
			if err := saveConfigs(); err != nil {
				http.Error(w, fmt.Sprintf("Save error: %v", err), 500)
				return
			}
			log.Printf("✏️ Card renamed: %s -> %s", name, newName)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
			return
		}
	}
	http.Error(w, "Not found", 404)
}

func resolveDir(dir string) string {
	if dir == "" {
		dir = "/home"
	}
	for {
		_, err := os.Stat(dir)
		if err == nil {
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			dir = "/home"
			break
		}
		dir = parent
	}
	return dir
}

func handleBrowse(w http.ResponseWriter, r *http.Request) {
	dir := resolveDir(r.URL.Query().Get("dir"))

	entries, err := os.ReadDir(dir)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	type entry struct {
		Name  string `json:"name"`
		IsDir bool   `json:"is_dir"`
		Size  int64  `json:"size"`
	}

	entriesOut := make([]entry, 0, len(entries)+1)
	if dir != "/" {
		parent := dir
		if strings.HasSuffix(parent, "/") {
			parent = strings.TrimSuffix(parent, "/")
		}
		if idx := strings.LastIndex(parent, "/"); idx > 0 {
			parent = parent[:idx]
		} else {
			parent = "/"
		}
		entriesOut = append(entriesOut, entry{Name: "..", IsDir: true, Size: 0})
	}

	showHidden := r.URL.Query().Get("showHidden") == "1"

	for _, e := range entries {
		if !showHidden && strings.HasPrefix(e.Name(), ".") {
			continue
		}
		fullPath := filepath.Join(dir, e.Name())
		stat, err := os.Stat(fullPath)
		if err != nil {
			continue
		}
		entriesOut = append(entriesOut, entry{Name: e.Name(), IsDir: stat.IsDir(), Size: stat.Size()})
	}

	resp := map[string]any{
		"dir":     dir,
		"entries": entriesOut,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func handleStat(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	_, err := os.Stat(path)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"exists": err == nil})
}

func loadConfigs() {
	data, err := os.ReadFile(flagConfig)
	if err != nil {
		log.Printf("⚠️ %s not found: %v", flagConfig, err)
		configs = []Config{}
		return
	}

	// Try new format (object with global_runtime + configs)
	var cf configFile
	if err := json.Unmarshal(data, &cf); err == nil && cf.Configs != nil {
		configs = cf.Configs
		globalRuntime = cf.GlobalRuntime
		globalHfCache = cf.HfCache
		log.Printf("📦 Loaded %d model configs (global_runtime: %s, hf_cache: %s)", len(configs), orDefault(globalRuntime, "<unset>"), orDefault(globalHfCache, "<unset>"))
		return
	}

	// Fall back to old format (plain array)
	if err := json.Unmarshal(data, &configs); err != nil {
		log.Printf("⚠️ Error parsing %s: %v", flagConfig, err)
		configs = []Config{}
		return
	}
	globalRuntime = ""
	log.Printf("📦 Loaded %d model configs", len(configs))
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func getConfigByName(name string) *Config {
	for i := range configs {
		if configs[i].Name == name {
			return &configs[i]
		}
	}
	return nil
}

func handleGPUInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nvidia-smi",
		"--query-gpu=index,name,memory.used,memory.total,temperature.gpu,power.draw",
		"--format=csv,noheader,nounits")
	out, err := cmd.Output()
	if err != nil {
		json.NewEncoder(w).Encode([]any{})
		return
	}
	type gpu struct {
		Index   int     `json:"index"`
		Name    string  `json:"name"`
		MemUsed float64 `json:"mem_used"`
		MemTot  float64 `json:"mem_tot"`
		Temp    int     `json:"temp"`
		PowerW  float64 `json:"power_w"`
	}
	var gpus []gpu
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Split(line, ", ")
		if len(parts) < 6 {
			continue
		}
		idx, _ := strconv.Atoi(parts[0])
		memUsed, _ := strconv.ParseFloat(parts[2], 64)
		memTot, _ := strconv.ParseFloat(parts[3], 64)
		temp, _ := strconv.Atoi(parts[4])
		power, _ := strconv.ParseFloat(parts[5], 64)
		gpus = append(gpus, gpu{
			Index:   idx,
			Name:    parts[1],
			MemUsed: memUsed,
			MemTot:  memTot,
			Temp:    temp,
			PowerW:  power,
		})
	}
	json.NewEncoder(w).Encode(gpus)
}

func handleOS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	osName := "linux"
	if strings.Contains(strings.ToLower(runtime.GOOS), "windows") {
		osName = "windows"
	} else if strings.Contains(strings.ToLower(runtime.GOOS), "darwin") {
		osName = "darwin"
	}
	home := os.Getenv("HOME")
	if home == "" {
		home = os.Getenv("USERPROFILE")
	}
	json.NewEncoder(w).Encode(map[string]any{
		"os":   osName,
		"home": home,
	})
}

func handleMkdir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	r.ParseForm()
	path := r.FormValue("path")
	if path == "" {
		http.Error(w, "path required", 400)
		return
	}
	if err := os.MkdirAll(path, 0755); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleParseCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	r.ParseForm()
	cmd := r.FormValue("command")
	if cmd == "" {
		http.Error(w, "command required", 400)
		return
	}

	// Strip line continuations (backslash + newline)
	re := regexp.MustCompile(`\\\s*\n\s*`)
	cmd = re.ReplaceAllString(cmd, " ")

	// Parse tokens respecting quotes
	tokens, err := parseArgsString(cmd)
	if err != nil {
		http.Error(w, fmt.Sprintf("Parse error: %v", err), 400)
		return
	}
	if len(tokens) == 0 {
		http.Error(w, "Empty command", 400)
		return
	}

	binary := tokens[0]
	args := strings.Join(tokens[1:], " ")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"binary": binary, "args": args})
}

type wizardSaveRequest struct {
	Runtime string      `json:"runtime"`
	HfCache string      `json:"hf_cache"`
	Models  []ModelInfo `json:"models"`
}

func handleWizardSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	var req wizardSaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Bad request", 400)
		return
	}

	globalRuntime = req.Runtime
	globalHfCache = req.HfCache
	if globalHfCache != "" {
		os.MkdirAll(globalHfCache, 0755)
	}

	configs = nil
	usedNames := map[string]int{}
	for _, m := range req.Models {
		usedNames[m.Name]++
		name := m.Name
		if usedNames[m.Name] > 1 {
			name = fmt.Sprintf("%s (%d)", m.Name, usedNames[m.Name])
		}
		configs = append(configs, Config{
			Name:       name,
			Args:       []string{"-m", m.Path, "--ctx-size", "2048"},
			DefaultCtx: 2048,
		})
	}

	if err := saveConfigs(); err != nil {
		http.Error(w, fmt.Sprintf("Save error: %v", err), 500)
		return
	}

	hasModels := len(req.Models) > 0
	log.Printf("📝 Wizard save: runtime=%s hf_cache=%s models=%d", orDefault(globalRuntime, "<unset>"), orDefault(globalHfCache, "<unset>"), len(req.Models))
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status": "ok", "hasModels": hasModels})
}

type firstRunResponse struct {
	FirstRun bool `json:"firstRun"`
}

type BinaryInfo struct {
	Path    string `json:"path"`
	Version string `json:"version"`
}

type ModelInfo struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type SmartScanResponse struct {
	Binaries []BinaryInfo      `json:"binaries"`
	Models   []ModelInfo       `json:"models"`
	HfCache  string            `json:"hf_cache"`
	Env      map[string]string `json:"env"`
}

func handleFirstRun(w http.ResponseWriter, r *http.Request) {
	_, err := os.Stat(flagConfig)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(firstRunResponse{FirstRun: os.IsNotExist(err)})
}

func handleSmartScan(w http.ResponseWriter, r *http.Request) {
	resp := SmartScanResponse{
		Binaries: []BinaryInfo{},
		Models:   []ModelInfo{},
		Env:      make(map[string]string),
	}

	checkEnv := func(keys ...string) {
		for _, k := range keys {
			if v := os.Getenv(k); v != "" {
				resp.Env[k] = v
			}
		}
	}
	checkEnv("LLAMA_BIN", "HF_HOME", "HF_HUB_CACHE", "CUDA_VISIBLE_DEVICES")

	seen := map[string]bool{}

	if p, err := exec.LookPath("llama-server"); err == nil {
		if !seen[p] {
			resp.Binaries = append(resp.Binaries, BinaryInfo{Path: p})
			seen[p] = true
		}
	}
	if p, err := exec.LookPath("llama.cpp"); err == nil {
		if !seen[p] {
			resp.Binaries = append(resp.Binaries, BinaryInfo{Path: p})
			seen[p] = true
		}
	}

	commonDirs := []string{
		filepath.Join(os.Getenv("HOME"), ".local", "bin", "llama-server"),
		"/usr/local/bin/llama-server",
		"/usr/bin/llama-server",
		"/opt/llama/llama-server",
	}
	for _, p := range commonDirs {
		if _, err := os.Stat(p); err == nil && !seen[p] {
			resp.Binaries = append(resp.Binaries, BinaryInfo{Path: p})
			seen[p] = true
		}
	}

	binaryCtx, binaryCancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer binaryCancel()

	var candidateDirs []string
	scanForLlamaDirs := func(root string) {
		entries, err := os.ReadDir(root)
		if err != nil {
			return
		}
		for _, e := range entries {
			fullPath := filepath.Join(root, e.Name())
			if e.IsDir() {
				if strings.Contains(strings.ToLower(e.Name()), "llama") {
					candidateDirs = append(candidateDirs, fullPath)
				}
				continue
			}
			if e.Type()&os.ModeSymlink != 0 {
				if target, err := os.Stat(fullPath); err == nil && target.IsDir() {
					if strings.Contains(strings.ToLower(e.Name()), "llama") {
						candidateDirs = append(candidateDirs, fullPath)
					}
				}
			}
		}
	}

	// Search /root/ directly
	scanForLlamaDirs("/root")

	// Search inside every user home in /home/
	homeEntries, err := os.ReadDir("/home")
	if err == nil {
		for _, he := range homeEntries {
			if he.IsDir() || (he.Type()&os.ModeSymlink != 0) {
				userHome := filepath.Join("/home", he.Name())
				scanForLlamaDirs(userHome)
			}
		}
	}

	for _, base := range candidateDirs {
		filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
			select {
			case <-binaryCtx.Done():
				return binaryCtx.Err()
			default:
			}
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if d.Name() == ".git" || d.Name() == ".cache" || d.Name() == "vendor" {
					return filepath.SkipDir
				}
				return nil
			}
			if d.Name() == "llama-server" || d.Name() == "llama-server.exe" {
				if !seen[path] {
					resp.Binaries = append(resp.Binaries, BinaryInfo{Path: path})
					seen[path] = true
				}
			}
			return nil
		})
	}

	for i, b := range resp.Binaries {
		if out, err := exec.Command(b.Path, "--version").Output(); err == nil {
			resp.Binaries[i].Version = strings.TrimSpace(string(out))
		}
	}

	walker := func(root string) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		done := make(chan struct{}, 1)
		go func() {
			filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
				}
				if err != nil {
					return nil
				}
				if d.IsDir() {
					if d.Name() == ".git" {
						return filepath.SkipDir
					}
					return nil
				}
				if strings.HasSuffix(strings.ToLower(path), ".gguf") {
					info, _ := d.Info()
					var size int64
					if info != nil {
						size = info.Size()
					}
					resp.Models = append(resp.Models, ModelInfo{
						Path: path,
						Name: strings.TrimSuffix(d.Name(), ".gguf"),
						Size: size,
					})
				}
				return nil
			})
			done <- struct{}{}
		}()
		<-done
	}

	scanDirs := []string{
		"models",
		filepath.Join(os.Getenv("HOME"), "models"),
		filepath.Join(os.Getenv("HOME"), ".models"),
		filepath.Join(os.Getenv("HOME"), ".cache", "huggingface", "hub"),
	}

	// Also look in each user's home for common model directories
	homeEntries, _ = os.ReadDir("/home")
	for _, he := range homeEntries {
		userHome := filepath.Join("/home", he.Name())
		scanDirs = append(scanDirs,
			filepath.Join(userHome, "models"),
			filepath.Join(userHome, ".models"),
		)
	}
	scanDirs = append(scanDirs, filepath.Join("/root", "models"), filepath.Join("/root", ".models"))

	scanDirs = append(scanDirs, resp.Env["HF_HUB_CACHE"], resp.Env["HF_HOME"])
	for _, d := range scanDirs {
		if d != "" {
			if fi, err := os.Stat(d); err == nil && fi.IsDir() {
				walker(d)
				if d == resp.Env["HF_HOME"] || d == resp.Env["HF_HUB_CACHE"] {
					resp.HfCache = d
				}
			}
		}
	}

	if resp.HfCache == "" {
		def := filepath.Join(os.Getenv("HOME"), ".cache", "huggingface", "hub")
		resp.HfCache = def
	}

	if resp.HfCache != "" && globalHfCache == "" {
		globalHfCache = resp.HfCache
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

type firstRunSetupRequest struct {
	Action    string `json:"action"` // "quick", "hf", "manual", "template"
	Runtime   string `json:"runtime,omitempty"`
	Models    []struct {
		Path string `json:"path"`
		Name string `json:"name"`
	} `json:"models,omitempty"`
	HfRepo   string `json:"hf_repo,omitempty"`
	HfFile   string `json:"hf_file,omitempty"`
	HfCache  string `json:"hf_cache,omitempty"`
}

func handleFirstRunSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	var req firstRunSetupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Bad request", 400)
		return
	}

	switch req.Action {
	case "quick":
		log.Printf("🔍 Quick setup: runtime=%q, models=%d", req.Runtime, len(req.Models))
		globalRuntime = req.Runtime
		usedNames := map[string]int{}
		for _, m := range req.Models {
			usedNames[m.Name]++
			name := m.Name
			if usedNames[m.Name] > 1 {
				name = fmt.Sprintf("%s (%d)", m.Name, usedNames[m.Name])
			}
			log.Printf("  model: name=%q path=%q", name, m.Path)
			configs = append(configs, Config{
				Name: name,
				Args: []string{"-m", m.Path, "--ctx-size", "2048"},
				DefaultCtx: 2048,
			})
		}
		if len(configs) == 0 {
			configs = append(configs, Config{
				Name: "My Model",
				Args: []string{"-m", "/path/to/model.gguf", "--ctx-size", "2048"},
				DefaultCtx: 2048,
			})
		}
		if err := saveConfigs(); err != nil {
			http.Error(w, fmt.Sprintf("Save error: %v", err), 500)
			return
		}
		log.Printf("📝 Quick setup: %d cards, runtime=%s", len(configs), orDefault(globalRuntime, "<unset>"))

	case "hf":
		globalRuntime = req.Runtime
		cacheDir := resolveHfCache(req.HfCache)
		if cacheDir != "" {
			os.MkdirAll(cacheDir, 0755)
		}
		args := []string{"--hf-repo", req.HfRepo}
		if req.HfFile != "" {
			args = append(args, "--hf-file", req.HfFile)
		}
		args = append(args, "--ctx-size", "2048")
		env := map[string]string{}
		if cacheDir != "" {
			env["HF_HUB_CACHE"] = cacheDir
		}
		configs = append(configs, Config{
			Name: orDefault(req.HfFile, req.HfRepo),
			Args: args,
			Env:  env,
			DefaultCtx: 2048,
		})
		if err := saveConfigs(); err != nil {
			http.Error(w, fmt.Sprintf("Save error: %v", err), 500)
			return
		}
		log.Printf("📝 HF setup: repo=%s file=%s cache=%s", req.HfRepo, req.HfFile, cacheDir)

	case "manual":
		globalRuntime = req.Runtime
		if req.HfRepo != "" {
			cacheDir := resolveHfCache(req.HfCache)
			if cacheDir != "" {
				os.MkdirAll(cacheDir, 0755)
			}
			args := []string{"--hf-repo", req.HfRepo}
			if req.HfFile != "" {
				args = append(args, "--hf-file", req.HfFile)
			}
			args = append(args, "--ctx-size", "2048")
			env := map[string]string{}
			if cacheDir != "" {
				env["HF_HUB_CACHE"] = cacheDir
			}
			configs = append(configs, Config{
				Name: orDefault(req.HfFile, req.HfRepo),
				Args: args,
				Env:  env,
				DefaultCtx: 2048,
			})
		} else {
			configs = append(configs, Config{
				Name: "My Model",
				Args: []string{"-m", "/path/to/model.gguf", "--ctx-size", "2048"},
				DefaultCtx: 2048,
			})
		}
		if err := saveConfigs(); err != nil {
			http.Error(w, fmt.Sprintf("Save error: %v", err), 500)
			return
		}
		log.Printf("📝 Manual setup: runtime=%s", orDefault(globalRuntime, "<unset>"))

	case "template":
		configs = []Config{
			{Name: "My Model", Args: []string{"-m", "/path/to/model.gguf", "--ctx-size", "2048"}, DefaultCtx: 2048},
		}
		if err := saveConfigs(); err != nil {
			http.Error(w, fmt.Sprintf("Save error: %v", err), 500)
			return
		}
		log.Printf("📝 Created template config")

	default:
		http.Error(w, "Unknown action", 400)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func resolveHfCache(cacheArg string) string {
	if cacheArg != "" {
		globalHfCache = cacheArg
		return cacheArg
	}
	if globalHfCache != "" {
		return globalHfCache
	}
	if env := os.Getenv("HF_HUB_CACHE"); env != "" {
		globalHfCache = env
		return env
	}
	if env := os.Getenv("HF_HOME"); env != "" {
		globalHfCache = env
		return env
	}
	def := filepath.Join(os.Getenv("HOME"), ".cache", "huggingface", "hub")
	globalHfCache = def
	return def
}

func hasHfRepoFlag(args []string) bool {
	for _, a := range args {
		if a == "--hf-repo" || strings.HasPrefix(a, "--hf-repo=") {
			return true
		}
	}
	return false
}
