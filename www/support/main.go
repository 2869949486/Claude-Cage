package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

//go:embed prompt.md
var prompt string

const origin = "https://claude-cage.com"

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type request struct {
	Question string    `json:"question"`
	History  []message `json:"history"`
	Web      bool      `json:"web"`
}
type quota struct {
	sync.Mutex
	hour, day int64
	total     int
	ips       map[string]int
}

func (q *quota) take(ip string, now time.Time) bool {
	q.Lock()
	defer q.Unlock()
	h := now.Unix() / 3600
	d := h / 24
	if h != q.hour {
		q.hour = h
		q.ips = map[string]int{}
	}
	if d != q.day {
		q.day = d
		q.total = 0
	}
	if q.total >= 600 || q.ips[ip] >= 20 {
		return false
	}
	q.total++
	q.ips[ip]++
	return true
}
func respond(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
func fail(w http.ResponseWriter, status int, msg string) {
	respond(w, status, map[string]string{"error": msg})
}
func complete(ctx context.Context, key string, messages []message) (string, error) {
	body, _ := json.Marshal(map[string]any{"model": "deepseek-flash", "messages": messages, "max_tokens": 1800, "stream": false})
	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.token-link.shop/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("model status %d", resp.StatusCode)
	}
	var result struct{ Choices []struct{ Message message } }
	if err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
		return "", err
	}
	if len(result.Choices) == 0 || strings.TrimSpace(result.Choices[0].Message.Content) == "" {
		return "", errors.New("empty model response")
	}
	return result.Choices[0].Message.Content, nil
}
func main() {
	key := os.Getenv("TOKEN_LINK_API_KEY")
	if key == "" {
		log.Fatal("missing model credential")
	}
	rev, err := os.ReadFile("corpus.tar.gz.rev")
	if err != nil {
		log.Fatal(err)
	}
	sha := strings.TrimSpace(string(rev))
	if !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(sha) {
		log.Fatal("invalid corpus revision")
	}
	ix, err := loadIndex("corpus.tar.gz", sha)
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	lim := &quota{}
	slots := make(chan struct{}, 5)
	mux.HandleFunc("/ask", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Vary", "Origin")
		if r.Header.Get("Origin") != origin {
			fail(w, 403, "请从官网答疑页提问。")
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		if r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Allow-Methods", "POST")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(204)
			return
		}
		if r.Method != "POST" {
			fail(w, 405, "请使用提问表单。")
			return
		}
		var in request
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
		if d.Decode(&in) != nil || d.Decode(&struct{}{}) != io.EOF || len(in.History) > 4 {
			fail(w, 400, "问题过长或格式有误。")
			return
		}
		in.Question = strings.TrimSpace(in.Question)
		if in.Question == "" || utf8.RuneCountInString(in.Question) > 1400 {
			fail(w, 400, "请输入 1–1400 个字符的问题。")
			return
		}
		query := in.Question
		for i, m := range in.History {
			if (i%2 == 0 && m.Role != "user") || (i%2 == 1 && m.Role != "assistant") || utf8.RuneCountInString(m.Content) > 1800 || len(in.History)%2 != 0 {
				fail(w, 400, "对话格式有误，请重新提问。")
				return
			}
		}
		if len(in.History) >= 2 {
			query += " " + in.History[len(in.History)-2].Content
		}
		// The reverse proxy overwrites this header with the actual peer address.
		ip := net.ParseIP(r.Header.Get("X-Real-IP"))
		if ip == nil {
			host, _, _ := net.SplitHostPort(r.RemoteAddr)
			ip = net.ParseIP(host)
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			fail(w, 429, "当前提问较多，请稍后再试。")
			return
		}
		if !lim.take(ip.String(), time.Now()) {
			fail(w, 429, "当前提问额度已用完，请稍后再试。")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 75*time.Second)
		defer cancel()
		rules, err := os.ReadFile("rules.md")
		if err != nil {
			fail(w, 503, "答疑规则暂不可用，请稍后再试。")
			return
		}
		refs := ix.search(query)
		external := 0
		if in.Web {
			webCtx, stop := context.WithTimeout(ctx, 5*time.Second)
			ws := webSources(webCtx, in.Question)
			stop()
			external = len(ws)
			refs = append(refs, ws...)
		}
		var notes strings.Builder
		for i, s := range refs {
			fmt.Fprintf(&notes, "[%d] %s\n%s\n%s\n\n", i+1, s.Title, s.URL, s.Text)
		}
		system := prompt + "\n维护者规则：\n" + string(rules)
		messages := append([]message{{"system", system}}, in.History...)
		messages = append(messages, message{"user", fmt.Sprintf("用户问题：\n%s\n\n可参考资料（外部搜索命中 %d 条）：\n%s", in.Question, external, notes.String())})
		answer, err := complete(ctx, key, messages)
		if err != nil {
			log.Printf("answer unavailable: %T", err)
			fail(w, 502, "模型暂时没有返回回答，请稍后重试。")
			return
		}
		respond(w, 200, map[string]any{"answer": answer, "sources": refs, "webCount": external})
	})
	server := &http.Server{Addr: "127.0.0.1:18152", Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 82 * time.Second, IdleTimeout: 35 * time.Second}
	log.Fatal(server.ListenAndServe())
}
