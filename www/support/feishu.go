package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type larkMessage struct {
	ID      string `json:"message_id"`
	Chat    string `json:"chat_id"`
	Parent  string `json:"parent_id"`
	Root    string `json:"root_id"`
	Type    string `json:"msg_type"`
	Created string `json:"create_time"`
	Deleted bool   `json:"deleted"`
	Sender  struct {
		ID   string
		Type string `json:"sender_type"`
	} `json:"sender"`
	Body struct{ Content string } `json:"body"`
}
type feishu struct {
	store *lessons
	owner string
	cli   string
}

func (f feishu) call(args []string, output any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, f.cli, append(args, "--as", "bot")...)
	// The CLI only needs its own bot profile, never the model credential.
	cmd.Env = []string{"HOME=" + os.Getenv("HOME"), "PATH=" + os.Getenv("PATH"), "LANG=C.UTF-8"}
	raw, err := cmd.Output()
	var envelope struct {
		OK    bool
		Data  json.RawMessage
		Error struct {
			Code int
			Type string
		}
	}
	if len(raw) == 0 {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			raw = exit.Stderr
		}
	}
	if json.Unmarshal(raw, &envelope) != nil || !envelope.OK || err != nil {
		return fmt.Errorf("Feishu CLI %s failed (code %d, %v)", args[0], envelope.Error.Code, err)
	}
	return json.Unmarshal(envelope.Data, output)
}
func (f feishu) send(l lesson) error {
	text := "官网答疑 · 待补充 " + l.ID + "\n\n" + l.Question + "\n\n请引用这条消息回复可对外使用的答案，或发送「答 " + l.ID + " 答案」。回复「忽略」可跳过。之后引用同一条消息可更正答案。"
	var msg struct {
		MessageID string `json:"message_id"`
		ChatID    string `json:"chat_id"`
	}
	err := f.call([]string{"im", "+messages-send", "--user-id", f.owner, "--text", text, "--idempotency-key", "support-" + l.ID}, &msg)
	if err != nil {
		return err
	}
	if msg.MessageID == "" || msg.ChatID == "" {
		return errors.New("Feishu send returned no message/chat ID")
	}
	s := f.store
	s.Lock()
	defer s.Unlock()
	l = s.items[l.ID]
	l.Message = msg.MessageID
	l.Chat = msg.ChatID
	return s.saveLocked(l)
}
func (f feishu) apply(m larkMessage, chat string) error {
	if m.Deleted || m.Type != "text" || m.Chat != chat || m.ID == "" || m.Sender.ID != f.owner || m.Sender.Type != "user" {
		return nil
	}
	var body struct{ Text string }
	if json.Unmarshal([]byte(m.Body.Content), &body) != nil {
		return nil
	}
	text := strings.TrimSpace(body.Text)
	s := f.store
	s.Lock()
	defer s.Unlock()
	var l lesson
	if m.Parent != "" || m.Root != "" {
		for _, v := range s.items {
			if v.Chat == chat && v.Message != "" && (v.Message == m.Parent || v.Message == m.Root) {
				l = v
				break
			}
		}
	}
	if l.ID == "" {
		parts := strings.SplitN(text, " ", 3)
		if len(parts) != 3 || parts[0] != "答" {
			return nil
		}
		l = s.items[parts[1]]
		text = strings.TrimSpace(parts[2])
	}
	if l.ID == "" || l.Chat != chat || l.Message == "" || l.Reply == m.ID || text == "" || utf8.RuneCountInString(text) > 6000 {
		return nil
	}
	stamp, err := strconv.ParseInt(m.Created, 10, 64)
	if err != nil {
		return err
	}
	if stamp < l.Updated {
		return nil
	}
	l.Answer = text
	l.Ignored = text == "忽略"
	if l.Ignored {
		l.Answer = ""
	}
	l.Reply = m.ID
	l.Updated = stamp
	return s.saveLocked(l)
}
func (f feishu) receive(chat string, first int64) error {
	file := filepath.Join(f.store.dir, "inbox.cursor")
	raw, err := os.ReadFile(file)
	if err == nil {
		first, err = strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
		if err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	end := time.Now().Unix() - 3
	if end <= first {
		return nil
	}
	params := map[string]any{"container_id_type": "chat", "container_id": chat, "start_time": strconv.FormatInt(first-2, 10), "end_time": strconv.FormatInt(end, 10), "page_size": 50, "sort_type": "ByCreateTimeAsc"}
	for {
		q, _ := json.Marshal(params)
		var result struct {
			Items []larkMessage
			More  bool   `json:"has_more"`
			Token string `json:"page_token"`
		}
		if err = f.call([]string{"api", "GET", "/open-apis/im/v1/messages", "--params", string(q)}, &result); err != nil {
			return err
		}
		for _, m := range result.Items {
			if err = f.apply(m, chat); err != nil {
				return err
			}
		}
		if !result.More {
			break
		}
		if result.Token == "" || params["page_token"] == result.Token {
			return errors.New("invalid Feishu next page")
		}
		params["page_token"] = result.Token
	}
	return writeAtomic(file, []byte(strconv.FormatInt(end, 10)))
}
func (f feishu) run() {
	for {
		l, chat, first := f.store.next()
		if l.ID != "" {
			if err := f.send(l); err != nil {
				log.Printf("question delivery: %v", err)
			}
		}
		if chat != "" {
			if err := f.receive(chat, first); err != nil {
				log.Printf("answer collection: %v", err)
			}
		}
		time.Sleep(30 * time.Second)
	}
}
