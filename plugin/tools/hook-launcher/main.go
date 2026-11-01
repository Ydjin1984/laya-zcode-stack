// Команда laya-hook — лаунчер хуков плагина davinci-laya-decisions.
//
// Зачем: ZCode запускает каждый хук отдельным процессом, и на Windows старт Node
// стоит ~290–330 мс на каждое событие — при том, что для явно читающих команд
// (ls/cat/git log/rg…) гейту нечего проверять. Лаунчер решает «нужен ли полный
// хук» за ~10 мс и запускает Node только когда он действительно нужен.
//
// Границы ответственности: здесь НЕТ логики решений — только консервативный
// whitelist «это точно чтение». Любое сомнение (цепочки, перенаправления,
// подстановки, незнакомый инструмент) → передаём в Node. Список — только
// разрешающий: пропустить опасное он не может по построению.
//
// Сборка: build-launcher.cmd (или: go build -o bin/laya-hook.exe .).
// Использование (из hooks.json): laya-hook.exe <pre|post> <путь к хук-скрипту>
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// hookInput — минимально нужная часть входа хука.
type hookInput struct {
	ToolName        string `json:"tool_name"`
	SessionID       string `json:"session_id"`
	PermissionMode  string `json:"permission_mode"`
	PermissionCamel string `json:"permissionMode"`
	Mode            string `json:"mode"`
	ToolInput       struct {
		Command string `json:"command"`
	} `json:"tool_input"`
}

// permMode повторяет permissionModeOf из gates.mjs: хост присылает разные ключи.
func (in hookInput) permMode() string {
	for _, v := range []string{in.PermissionMode, in.PermissionCamel, in.Mode} {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

// readOnlyVerbs — команды, которые являются чтением при условии отсутствия
// цепочек/перенаправлений/подстановок (проверяется отдельно).
var readOnlyVerbs = map[string]bool{
	"ls": true, "dir": true, "cat": true, "type": true, "head": true, "tail": true,
	"wc": true, "stat": true, "file": true, "pwd": true, "echo": true, "where": true,
	"which": true, "whoami": true, "hostname": true, "nvidia-smi": true,
	"rg": true, "grep": true, "findstr": true,
}

// readOnlyGit — подкоманды git, которые ничего не меняют.
// «git status» НАМЕРЕННО не здесь: post-tool берёт из него доказательство
// состояния дерева для ledger, и пропуск стоил бы точности гейта.
var readOnlyGit = map[string]bool{
	"log": true, "diff": true, "show": true, "branch": true, "remote": true,
	"tag": true, "describe": true, "rev-parse": true, "ls-files": true, "blame": true,
}

// readOnlyNpm — подкоманды npm без побочных эффектов.
var readOnlyNpm = map[string]bool{"ls": true, "view": true, "outdated": true}

// dangerousChars — признаки, при которых команда НЕ считается простым чтением:
// цепочки, конвейеры, перенаправления, подстановки, многострочность.
// Осторожность здесь дешевле ошибки: лишний запуск Node — миллисекунды,
// пропущенная проверка — инцидент.
const dangerousChars = ";&|>`$\n\r\\"

// sensitivePathRe — чтение этих путей НЕ пропускается, даже если команда похожа
// на простой `cat`: именно через терминал чаще всего утекают ключи и секреты, и
// в Node такие чтения попадают под детерминированные правила (private-key-read,
// cloud-credentials, ssh-dir-access). Найдено тестом launcher.test.mjs: без этой
// проверки `cat ~/.aws/credentials` проходил мимо гейта.
var sensitivePathRe = regexp.MustCompile(`(?i)(\.ssh|\.aws|\.azure|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials|id_rsa|id_ed25519|id_ecdsa|\.pem|\.p12|\.pfx|\.keystore|\.env)`)

func isReadOnlyCommand(cmd string) bool {
	c := strings.TrimSpace(cmd)
	if c == "" || strings.ContainsAny(c, dangerousChars) {
		return false
	}
	if sensitivePathRe.MatchString(c) {
		return false
	}
	fields := strings.Fields(c)
	if len(fields) == 0 {
		return false
	}
	verb := strings.ToLower(fields[0])
	second := ""
	if len(fields) > 1 {
		second = strings.ToLower(fields[1])
	}
	switch verb {
	case "git":
		return readOnlyGit[second]
	case "npm":
		return readOnlyNpm[second]
	case "find":
		// find опасен флагами -delete/-exec; всё остальное — обход каталогов.
		low := strings.ToLower(c)
		return !strings.Contains(low, "-delete") && !strings.Contains(low, "-exec")
	case "node", "go", "python", "python3":
		// «go version», «node --version», «python -v» — печать версии.
		return len(fields) == 2 && (second == "--version" || second == "version" || second == "-v")
	default:
		return readOnlyVerbs[verb]
	}
}

// configProbe — только те поля config.json, которые влияют на пропуск.
type configProbe struct {
	RiskGate struct {
		Mode        string   `json:"mode"`
		LayaPolicy  string   `json:"layaPolicy"`
		ActiveModes []string `json:"activeModes"`
	} `json:"riskGate"`
}

// dataDir повторяет порядок из src/config.mjs, чтобы лаунчер и Node читали
// один и тот же конфиг. Без env выбирается самый свежий каталог плагина:
// иначе ручной запуск читал бы старый ~/.zcode/davinci-laya-decisions.
func dataDir() string {
	for _, env := range []string{"DAVINCI_LAYA_DATA", "ZCODE_PLUGIN_DATA", "CLAUDE_PLUGIN_DATA"} {
		if v := os.Getenv(env); v != "" && !strings.Contains(v, "${") {
			return v
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	base := filepath.Join(home, ".zcode", "cli", "plugins", "data")
	entries, err := os.ReadDir(base)
	if err == nil {
		best := ""
		var bestTime time.Time
		for _, ent := range entries {
			if !ent.IsDir() || !strings.HasPrefix(ent.Name(), "davinci-laya-decisions@") {
				continue
			}
			dir := filepath.Join(base, ent.Name())
			st, err := os.Stat(filepath.Join(dir, "config.json"))
			if err != nil {
				continue
			}
			if best == "" || st.ModTime().After(bestTime) {
				best = dir
				bestTime = st.ModTime()
			}
		}
		if best != "" {
			return best
		}
	}
	return filepath.Join(home, ".zcode", "davinci-laya-decisions")
}

func loadConfig(path string) (configProbe, bool) {
	var cfg configProbe
	if path == "" {
		return cfg, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		// Нет config.json — штатный первый запуск: значения по умолчанию
		// (smart, без activeModes-фильтра) безопасны. Битая/нечитаемая
		// конфигурация — уже сомнение, тогда пробрасываем в Node.
		if os.IsNotExist(err) {
			return cfg, true
		}
		return cfg, false
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, false
	}
	return cfg, true
}

func contains(list []string, value string) bool {
	for _, v := range list {
		if v == value {
			return true
		}
	}
	return false
}

// writeSkipMetric — лёгкая запись в metrics JSONL без запуска Node. Нужна,
// чтобы решения «пропущено по permission mode» не исчезали из наблюдаемости.
func writeSkipMetric(reason string, in hookInput, cfg configProbe) {
	dir := dataDir()
	if dir == "" {
		return
	}
	now := time.Now()
	metricsDir := filepath.Join(dir, "metrics")
	if err := os.MkdirAll(metricsDir, 0o755); err != nil {
		return
	}
	name := fmt.Sprintf("decisions-%04d-%02d-%02d.jsonl", now.Year(), int(now.Month()), int(now.Day()))
	row := map[string]any{
		"ts":         now.UTC().Format("2006-01-02T15:04:05.000Z"),
		"kind":       "risk_gate",
		"session_id": in.SessionID,
		"tool":       in.ToolName,
		"source":     "hook:launcher",
		"mode":       cfg.RiskGate.Mode,
		"action":     "skip_mode",
		"reason":     reason,
		"latency_ms": 0,
		"elapsed_ms": nil,
		"checkpoint": nil,
		"extra": map[string]any{
			"permission_mode": in.permMode(),
			"active_modes":    cfg.RiskGate.ActiveModes,
			"launcher":        true,
		},
	}
	raw, err := json.Marshal(row)
	if err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(metricsDir, name), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(raw, '\n'))
}

// shouldSkip отвечает, можно ли обойтись без Node для этого события.
//
// Два независимых основания:
//  1. Permission mode вне activeModes (только PreToolUse): Node всё равно
//     вышел бы на первом шаге, поэтому запускать его бессмысленно. Решение
//     фиксируется лёгкой метрикой, а PostToolUse НЕ пропускается — evidence
//     должен собираться и в yolo.
//  2. Явно читающая Bash-команда при layaPolicy != "always" — как раньше.
//
// Любое сомнение (конфиг не прочитан, режим неизвестен, activeModes пуст) →
// запускаем Node: пропуск не должен отключать защиту по догадке.
func shouldSkip(mode string, in hookInput, cfg configProbe, cfgOK bool) (bool, string, bool) {
	if !cfgOK {
		return false, "", false
	}
	if mode == "pre" {
		pm := in.permMode()
		if cfg.RiskGate.Mode == "off" {
			return true, "risk_gate=off", false
		}
		if len(cfg.RiskGate.ActiveModes) > 0 && pm != "" && !contains(cfg.RiskGate.ActiveModes, pm) {
			return true, "permission_mode=" + pm + " вне activeModes", true
		}
	}
	if !strings.EqualFold(in.ToolName, "Bash") {
		return false, "", false
	}
	if !isReadOnlyCommand(in.ToolInput.Command) {
		return false, "", false
	}
	// «always» означает «спрашивать Laya на каждом вызове» — тогда не пропускаем.
	if cfg.RiskGate.LayaPolicy == "always" {
		return false, "", false
	}
	return true, "", false
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "[laya-hook] использование: laya-hook <pre|post> <hook.mjs>")
		os.Exit(0) // fail-open: сессия не должна страдать из-за вызова лаунчера
	}
	mode, script := os.Args[1], os.Args[2]

	raw, err := readAllStdin()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[laya-hook] stdin не прочитан: %v\n", err)
		os.Exit(0)
	}

	var in hookInput
	if err := json.Unmarshal(raw, &in); err != nil {
		// Разбор не удался — не гадаем, отдаём Node (там будет диагностика).
		runNode(script, raw)
		return
	}

	configPath := ""
	if dir := dataDir(); dir != "" {
		configPath = filepath.Join(dir, "config.json")
	}
	cfg, cfgOK := loadConfig(configPath)
	if skip, reason, metric := shouldSkip(mode, in, cfg, cfgOK); skip {
		// Пропускаем без вывода и без запуска Node. Для permission-skip пишем
		// лёгкую метрику: иначе решения «не спрашивали» исчезнут из наблюдаемости.
		if metric {
			writeSkipMetric(reason, in, cfg)
		}
		os.Exit(0)
	}
	runNode(script, raw)
}

// runNode запускает обычный хук, прозрачно передавая stdin/stdout/stderr.
func runNode(script string, stdin []byte) {
	cmd := exec.Command(resolveNode(), script)
	cmd.Stdin = bytes.NewReader(stdin)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if ok := asExitError(err, &exitErr); ok {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "[laya-hook] node не запущен: %v\n", err)
		os.Exit(0) // fail-open
	}
}

// resolveNode находит node.exe БЫСТРО.
//
// Замерено: exec.LookPath("node") на этой машине стоит 29–50 мс — это сканирование
// всего PATH с расширениями, и оно съедало почти всю экономию лаунчера на пути
// проброса. Поэтому сначала проверяются известные места установки (одна операция
// stat, доли миллисекунды), затем — кэш, записанный при первом успешном поиске,
// и только в последнюю очередь PATH.
func resolveNode() string {
	if env := os.Getenv("LAYA_NODE_EXE"); env != "" {
		return env
	}
	for _, candidate := range knownNodePaths() {
		if fileExists(candidate) {
			return candidate
		}
	}
	cachePath := nodeCachePath()
	if cached := readSmallFile(cachePath); cached != "" && fileExists(cached) {
		return cached
	}
	if resolved, err := exec.LookPath("node"); err == nil {
		if cachePath != "" {
			_ = os.WriteFile(cachePath, []byte(resolved), 0o644)
		}
		return resolved
	}
	return "node" // последний шанс: пусть система попробует сама
}

func knownNodePaths() []string {
	var paths []string
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA"} {
		if base := os.Getenv(env); base != "" {
			if env == "LOCALAPPDATA" || env == "APPDATA" {
				paths = append(paths, filepath.Join(base, "Programs", "nodejs", "node.exe"))
				paths = append(paths, filepath.Join(base, "nodejs", "node.exe"))
			} else {
				paths = append(paths, filepath.Join(base, "nodejs", "node.exe"))
			}
		}
	}
	return paths
}

// nodeCachePath — файл рядом с исполняемым файлом лаунчера (bin/.node-path).
func nodeCachePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(exe), ".node-path")
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

func readSmallFile(path string) string {
	if path == "" {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > 4096 {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func asExitError(err error, target **exec.ExitError) bool {
	if e, ok := err.(*exec.ExitError); ok {
		*target = e
		return true
	}
	return false
}

func readAllStdin() ([]byte, error) {
	var buf bytes.Buffer
	_, err := buf.ReadFrom(os.Stdin)
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
