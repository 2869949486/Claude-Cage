package workbench

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/google/uuid"
	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/guestos"
	"github.com/sylvinus/agent-vm/internal/guestprofile"
	"github.com/sylvinus/agent-vm/internal/host"
	"github.com/sylvinus/agent-vm/internal/hostimage"
	"github.com/sylvinus/agent-vm/internal/hostproxy"
)

type guestInstallRequest struct {
	GuestProfile *guestprofile.Options `json:"guest_profile,omitempty"`
	EditorTerms  bool                  `json:"editor_terms"`
	System       string                `json:"guest_system"`
	Media        string                `json:"media"`
	SHA256       string                `json:"sha256"`
	CloneKey     string                `json:"clone_key,omitempty"`
}

type guestInstallView struct {
	LinuxSystems []string              `json:"linux_systems,omitempty"`
	Reselect     bool                  `json:"reselect,omitempty"`
	System       string                `json:"system,omitempty"`
	Available    bool                  `json:"available"`
	Reason       string                `json:"reason,omitempty"`
	Fresh        bool                  `json:"fresh"`
	Pending      *guestos.Installation `json:"pending,omitempty"`
}

func (s *Server) guestInstallView() (guestInstallView, error) {
	v := guestInstallView{}
	if !s.localVMStorage() {
		return v, nil
	}
	pending, err := guestos.LoadInstallation(s.profile)
	if err != nil {
		return v, err
	}
	loc, err := cage.GetStorageLocation(s.profile)
	if err != nil {
		return v, err
	}
	v.Fresh = !loc.HasEnvironment
	v.Pending = pending
	if !v.Fresh && pending == nil {
		return v, nil
	}
	if pending != nil && !hostimage.IsLinux(pending.System) {
		// Recorded by an earlier version. It cannot continue, and it may only
		// be withdrawn while nothing was created for it.
		v.Reselect, err = guestos.UnstartedInstallation(s.profile, *pending)
		v.Reason = abandonedGuestMessage(pending.System)
		return v, err
	}
	v.LinuxSystems = linuxGuestSystems(runtime.GOOS, runtime.GOARCH)
	switch {
	case runtime.GOOS == "darwin" && (runtime.GOARCH == "arm64" || runtime.GOARCH == "amd64"), runtime.GOOS == "windows" && runtime.GOARCH == "amd64":
		// No host-matched guest; only the catalog Linux systems apply.
	case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
		identity, hostErr := hostimage.Host(context.Background())
		if hostErr != nil {
			v.Reason = hostErr.Error()
		} else {
			v.System = identity.System
		}
	default:
		return v, nil
	}
	if pending != nil {
		v.Reselect, err = guestos.UnstartedInstallation(s.profile, *pending)
		if err != nil {
			return v, err
		}
		catalog := pending.SourceKind == guestos.LinuxImageSource && canInstallCatalogLinux(pending.System) && pending.Source.Host.Arch == runtime.GOARCH
		if !catalog && pending.System != v.System {
			return v, errors.New("客户机安装记录与这台宿主不匹配")
		}
		if pending.SourceKind == guestos.LinuxImageSource && !catalog {
			return v, errors.New("客户机镜像架构与这台主机不匹配，请恢复原主机环境")
		}
	}
	if v.System == "" {
		return v, nil
	}
	v.Available = true
	return v, nil
}

func (s *Server) guestInstallation(w http.ResponseWriter, r *http.Request) {
	if !s.hasTrustedView(r) || !s.localVMStorage() {
		http.Error(w, "请在本机 Cage 窗口选择客户机系统", http.StatusForbidden)
		return
	}
	v, err := s.guestInstallView()
	if err != nil {
		requestError(w, err)
		return
	}
	if r.Method == http.MethodGet {
		jsonReply(w, v)
		return
	}
	if r.Method == http.MethodDelete {
		var body struct {
			ID uuid.UUID `json:"id"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if !v.Reselect || s.busy() || !s.op.TryLock() {
			message := "安装任务或磁盘已存在，请继续原安装"
			if v.Pending != nil && !hostimage.IsLinux(v.Pending.System) {
				message = abandonedGuestMessage(v.Pending.System)
			}
			http.Error(w, message, http.StatusConflict)
			return
		}
		defer s.op.Unlock()
		if err := guestos.ClearUnstartedInstallation(s.profile, body.ID); err != nil {
			requestError(w, err)
			return
		}
		jsonReply(w, map[string]bool{"cleared": true})
		return
	}
	http.Error(w, "请求方法无效", http.StatusMethodNotAllowed)
}

func (s *Server) beginGuestInstall(w http.ResponseWriter, r *http.Request, in guestInstallRequest) {
	if in.System == guestos.MacOS || in.System == guestos.Windows11 {
		http.Error(w, abandonedGuestMessage(in.System), http.StatusConflict)
		return
	}
	v, err := s.guestInstallView()
	if err != nil {
		requestError(w, err)
		return
	}
	catalog := canInstallCatalogLinux(in.System) && in.CloneKey == ""
	if v.Pending != nil {
		catalog = v.Pending.SourceKind == guestos.LinuxImageSource
	}
	if (!catalog && (!v.Available || v.System != in.System)) || !s.hasTrustedView(r) || (!v.Fresh && v.Pending == nil) {
		http.Error(w, "当前环境无法安装所选客户机系统", http.StatusConflict)
		return
	}
	install := guestos.Installation{Version: 1, System: in.System, Media: in.Media, SHA256: strings.ToLower(in.SHA256), ID: uuid.New(), EditorTerms: in.EditorTerms}
	if v.Pending != nil {
		if v.Pending.System != in.System || (in.Media != "" && in.Media != v.Pending.Media) || (in.SHA256 != "" && !strings.EqualFold(in.SHA256, v.Pending.SHA256)) {
			http.Error(w, "必须使用原先选择的系统和安装介质继续安装", http.StatusConflict)
			return
		}
		install = *v.Pending
	} else if in.CloneKey != "" {
		plan, planErr := s.hostClonePlan(r.Context())
		if planErr != nil {
			requestError(w, planErr)
			return
		}
		if plan.Key() != in.CloneKey || plan.Host.System != in.System {
			requestError(w, errors.New("本机版本或系统镜像信息已变化，请重新检测并匹配"))
			return
		}
		install.Source = plan
	} else if catalog {
		if in.Media != "" || in.SHA256 != "" || in.EditorTerms {
			requestError(w, errors.New("Ubuntu 使用 Cage 校验过的官方镜像，无需另选安装介质"))
			return
		}
		plan, err := linuxGuestImagePlan(r.Context(), s.profile, in.System, runtime.GOARCH)
		if err != nil {
			requestError(w, err)
			return
		}
		install.Source, install.SourceKind = plan, guestos.LinuxImageSource
	}
	if err := install.Validate(); err != nil {
		requestError(w, err)
		return
	}
	s.launch(w, "guest-install", func() error {
		s.jobs.execution().setSetupProgress(&SetupProgress{Phase: "image", System: install.System, Label: "正在准备 " + guestProgressName(install.System) + " 安装材料"})
		cfg, err := loadConfig(s.configPath)
		if err != nil {
			return err
		}
		if err := cfg.RequireManagedProxy(s.profile); err != nil {
			return err
		}
		lease, loc, err := cage.AcquireStorageUse(s.profile)
		if err != nil {
			return err
		}
		defer lease.Close()
		current, err := guestos.LoadInstallation(s.profile)
		if err != nil {
			return err
		}
		if current == nil && loc.HasEnvironment || current != nil && *current != install {
			return errors.New("已有其他环境或安装任务，请重新打开安装页面")
		}
		if install.Media != "" {
			f, err := os.Stat(install.Media)
			if err != nil || !f.Mode().IsRegular() {
				return errors.New("原安装镜像不可读，请恢复其原路径后重试")
			}
		}
		if !hostimage.IsLinux(install.System) {
			return errors.New(abandonedGuestMessage(install.System))
		}
		if err := s.prepareGuestProfile(in.GuestProfile); err != nil {
			return err
		}
		if err := guestos.SaveInstallation(s.profile, install); err != nil {
			return err
		}
		if install.Source.Host.System != "" {
			cache := filepath.Join(s.profile, "state", "guest-media", install.System)
			unstarted, err := guestos.UnstartedInstallation(s.profile, install)
			if err != nil {
				return err
			}
			minimumGiB := hostCloneSystemReserve
			if !unstarted {
				minimumGiB = 0
			}
			minimumGiB += int((install.Source.RemainingBytes(cache) + (1 << 30) - 1) / (1 << 30))
			if available, ok := host.FreeGiB(cache); ok && available < minimumGiB {
				return fmt.Errorf("创建所选系统至少需要 %d GiB 可用空间，当前有 %d GiB，请在存储设置中选择空间充足的位置", minimumGiB, available)
			}
			s.setMessage("正在准备 " + guestProgressName(install.System) + " 官方系统镜像…")
			transport := hostproxy.NewTransport()
			defer transport.CloseIdleConnections()
			prepared, prepareErr := hostimage.Prepare(s.operationContext(), cache, install.Source, s.jobs.execution(), transport)
			if prepareErr != nil {
				return prepareErr
			}
			install.Source, install.Media = prepared, prepared.Path
			install.SHA256 = strings.TrimPrefix(prepared.Digest, "sha256:")
			if err := guestos.RecordPreparedMedia(s.profile, install.ID, prepared); err != nil {
				return err
			}
		}
		if err := s.prepareEnvironment(); err != nil {
			return err
		}
		if err := hostimage.WriteLinuxTemplate(filepath.Join(s.profile, "state"), install.Source); err != nil {
			return err
		}
		if err := s.startEnvironment(true); err != nil {
			return err
		}
		return guestos.FinishLinuxInstallation(s.profile, install.ID)
	})
}
