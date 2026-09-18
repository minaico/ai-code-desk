# AI Code Desk — Hướng dẫn chi tiết

> Bản tóm tắt: [README tiếng Việt](../README.vi.md) · [English README](../README.md).
> Trang này là tài liệu vận hành đầy đủ: mọi script, mọi biến môi trường, API, bảo mật và xử lý sự cố.

Điều khiển terminal thật trên Windows (và Linux) từ trình duyệt PC hoặc điện thoại.
Backend là **node-pty + Windows ConPTY**, không phải `exec()`, nên mọi CLI tương
tác (Claude Code, PowerShell, Python REPL, git, npm, vim…) chạy đúng như trong
Windows Terminal.

```
iPhone / Android / PC
        |  HTTPS / WSS
        v
   Web Server (server/server.js)      <- restart thoải mái
        |  TCP 127.0.0.1 + shared key
        v
   PTY Host  (server/pty-host.js)     <- sở hữu mọi ConPTY session
        |
        +-- Windows PowerShell / PowerShell 7 / CMD / Git Bash
        +-- Claude Code, Python, Node, bất kỳ CLI nào
```

---

## Mục lục

- [Cài đặt nhanh](#cài-đặt-nhanh)
- [Development](#development)
- [Production trên Windows Server](#production-trên-windows-server)
- [Windows Service / Autostart](#windows-service--autostart)
- [Authentication](#authentication)
- [Cloudflare Tunnel](#cloudflare-tunnel)
- [Tab](#tab)
- [Desktop](#desktop)
- [Mobile](#mobile)
- [Claude Code từ xa](#claude-code-từ-xa)
- [Lịch sử session](#lịch-sử-session)
- [Nhật ký hội thoại với agent](#nhật-ký-hội-thoại-với-agent)
- [Nhiều máy](#nhiều-máy)
- [Giọng nói](#giọng-nói)
- [Session bền vững](#session-bền-vững)
- [API](#api)
- [Cấu hình](#cấu-hình-biến-môi-trường)
- [Logging & Diagnostics](#logging--diagnostics)
- [Bảo mật](#bảo-mật)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Giới hạn đã biết](#giới-hạn-đã-biết)

---

## Cài đặt nhanh

```powershell
cd C:\claudedeck
.\scripts\install.ps1 -Password "MatKhauRatManh" -Roots "C:\Users\ban;D:\du-an"
.\scripts\start.ps1
```

Mở `http://SERVER-IP:8080`.

`install.ps1` chạy `npm install`, `npm run build`, băm mật khẩu bằng scrypt và
lưu **hash** vào biến môi trường máy (mật khẩu gốc không bao giờ được ghi ra đâu cả).

---

## Development

```powershell
npm install
npm run build          # build UI vào dist\
npm start              # web server (tự spawn PTY host nếu chưa chạy)
npm run host           # chỉ chạy PTY host
npm run dev            # Vite dev server cho UI (proxy tay tới :8080)
npm test               # toàn bộ test
```

Không đặt gì thì server dùng **mật khẩu mặc định `123123`**. Tiện để chạy thử,
nhưng phải đổi trước khi mở ra ngoài mạng tin cậy.

---

## Production trên Windows Server

```powershell
# 1. Băm mật khẩu
node scripts\hash-password.js
#    -> copy chuỗi scrypt$...

# 2. Cài autostart (PowerShell Administrator)
.\scripts\install-service.ps1 `
    -PasswordHash "scrypt$..." `
    -Roots "C:\Users\svc-webterm\projects" `
    -Port 8080

# 3. Kiểm tra
.\scripts\status-service.ps1
```

### Bảng lệnh quản trị

| Việc cần làm | Lệnh |
|---|---|
| Cài dependency + build | `.\scripts\install.ps1` |
| **Bật lại sau khi tắt máy / mất điện** | `.\scripts\resume.ps1` (hoặc bấm đúp `scripts\resume.bat`) |
| Chạy thủ công (foreground) | `.\scripts\start.ps1` |
| Dừng tiến trình cục bộ | `.\scripts\stop.ps1` |
| Dừng **chỉ** web, giữ session | `.\scripts\stop.ps1 -WebOnly` |
| Kiểm tra tình trạng | `.\scripts\status.ps1` |
| Cài autostart (admin) | `.\scripts\install-service.ps1` |
| Gỡ autostart (admin) | `.\scripts\uninstall-service.ps1` |
| Start / stop / status autostart | `.\scripts\start-service.ps1` · `stop-service.ps1` · `status-service.ps1` |
| Gỡ toàn bộ | `.\scripts\uninstall.ps1 -PurgeData -PurgeModules` |
| Tunnel công khai để test | `.\scripts\start-cloudflare-test.ps1` |
| Biến máy này thành máy từ xa | `.\scripts\start-remote-host.ps1` |
| In key của máy này | `node scripts\host-key.js` |
| Xem nhóm máy / chuyển máy chính | `node scripts\machines.js` · `export` · `import <file>` |

---

## Windows Service / Autostart

`install-service.ps1` đăng ký **hai Scheduled Task**:

| Task | Chạy | Delay sau khi boot |
|---|---|---|
| `WebTerminal-PtyHost` | `node server\pty-host.js` | 10s |
| `WebTerminal-Web` | `node server\server.js` | 30s |

Cả hai đặt `RestartCount 999`, không giới hạn thời gian chạy, `StartWhenAvailable`.

Mặc định task chạy dưới **tài khoản hiện tại với LogonType S4U** — không lưu mật
khẩu Windows, vẫn giữ user profile nên Claude Code, npm, PATH của user hoạt động
bình thường. Muốn chạy dưới SYSTEM:

```powershell
.\scripts\install-service.ps1 -RunAsSystem
```

> SYSTEM có toàn quyền máy và **không** thấy profile của user đăng nhập
> (config Claude Code, npm cache, PATH riêng). Chỉ dùng khi bạn thật sự cần.

### Vì sao Scheduled Task chứ không phải Windows Service?

Node không phải service binary; muốn thành service thật cần wrapper (NSSM,
winsw). Scheduled Task là native, chịu reboot, tự restart, quản lý bằng
`Get-ScheduledTask` / Task Scheduler GUI. Nếu bạn vẫn muốn NSSM:

```powershell
nssm install WebTerminalPtyHost "C:\Program Files\nodejs\node.exe" "C:\path\wt\server\pty-host.js"
nssm install WebTerminalWeb     "C:\Program Files\nodejs\node.exe" "C:\path\wt\server\server.js"
nssm set WebTerminalWeb DependOnService WebTerminalPtyHost
```

---

## Authentication

Thứ tự ưu tiên:

1. `WEB_TERMINAL_PASSWORD_HASH` (khuyến nghị) — hash scrypt, sinh bằng
   `node scripts\hash-password.js`.
2. `WEB_TERMINAL_PASSWORD` — mật khẩu thô.
3. Không đặt gì → **mặc định `123123`**.

Mật khẩu mặc định là để chạy thử cho nhanh; nó an toàn hơn cách cũ (không mật
khẩu = ai vào được cổng là có shell) nhưng ai cũng đoán được. Server in cảnh báo
lúc khởi động và UI hiện toast khi còn dùng nó. Đổi bằng:

```powershell
node scripts\hash-password.js
[Environment]::SetEnvironmentVariable("WEB_TERMINAL_PASSWORD_HASH","scrypt$...","Machine")
```

Muốn tắt hẳn xác thực (chỉ cho localhost): đặt `WEB_TERMINAL_PASSWORD` thành
chuỗi rỗng.

Sau khi đăng nhập server đặt cookie **HttpOnly + SameSite=Lax** (thêm `Secure`
khi chạy sau HTTPS). Token là HMAC ký bằng khoá lưu ở `.data\secret.key`, nên
**restart web server không làm điện thoại bị đăng xuất**.

Chống lạm dụng:

- brute-force: chặn theo IP, backoff tăng dần, tối đa 8 lần sai.
- CSRF: mọi request thay đổi trạng thái phải có header `X-WT-Client` (form/ảnh
  từ site khác không đặt được header này).
- WebSocket: kiểm tra `Origin` khớp `Host`, và kiểm tra token/cookie trước khi
  cho upgrade.
- Mật khẩu không bao giờ được ghi log.

---

## Cloudflare Tunnel

### Test nhanh (Quick Tunnel)

```powershell
.\scripts\start-cloudflare-test.ps1
```

Script sẽ: kiểm tra `/health` → kiểm tra `cloudflared` → mở Quick Tunnel → in ra
`https://xxxx.trycloudflare.com`. WebSocket đi qua WSS trên cùng hostname nên
terminal hoạt động bình thường.

Script **từ chối chạy nếu chưa đặt mật khẩu** — Quick Tunnel là public.

### Production (named tunnel + Access)

```powershell
cloudflared tunnel login
cloudflared tunnel create webterm
```

`config.yml`:

```yaml
tunnel: webterm
credentials-file: C:\Users\<user>\.cloudflared\<id>.json
ingress:
  - hostname: term.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

```powershell
cloudflared tunnel route dns webterm term.example.com
cloudflared service install
```

Rồi bật **Cloudflare Access** cho `term.example.com` (Zero Trust → Access →
Applications) để có thêm một lớp xác thực trước cả trang login. Với cách này
**không cần mở cổng 8080 ra Internet**.

---

## Tab

### Tên tab đi theo thư mục

Một tab chưa được đặt tên riêng sẽ **mang tên thư mục nó đang đứng**, và đổi
theo mỗi lần `cd`:

| Thư mục | Tên tab |
|---|---|
| `C:\work\Test` | `Test` |
| `D:\src\claudedeck` | `claudedeck` |
| `C:\` | `C:\` |

Trong bảng Tab, công tắc **Tự đổi tên theo thư mục** luôn bắt đầu ở trạng thái
**tắt** và ô tên hiện tên tab đang dùng, sẵn sàng để sửa. Bật công tắc là hành
động cố ý để **xoá tên cũ** và trao tab lại cho thư mục; tắt lại thì tên cũ quay
về. Gõ tên cũng tự tắt công tắc.

Ở phía API, một `title` khác rỗng **luôn thắng**, kể cả khi cùng request có
`autoTitle: true` — nếu không thì cái tên vừa gõ sẽ bị vứt đi trong im lặng.

> **Tên tab và màu là tính năng phía PTY host.** Nếu PTY host đang chạy bản cũ
> hơn code, bảng Tab sẽ báo ngay trong dialog và việc lưu sẽ thất bại. Khởi động
> lại PTY host để dùng được — thao tác này **đóng mọi session đang chạy**:
>
> ```powershell
> .\scripts\stop.ps1          # dừng cả web server lẫn PTY host
> .\scripts\start.ps1
> ```

Thư mục được lấy từ OSC 9;9 do chính shell phát ra, nên nó đúng cả khi bạn `cd`
bên trong một script, không phải đoán từ prompt.

### Màu tab

Mỗi tab đặt được một màu trong 9 màu có sẵn (hoặc bỏ màu). Màu hiện ở viền tab,
nền tab khi đang chọn (chữ tự đổi đen/trắng cho dễ đọc), và vạch bên trái của thẻ
session trong panel.

**Mở bảng Tab** bằng bất kỳ cách nào sau đây:

| Cách | Ở đâu |
|---|---|
| Bấm vào **tên session** ở thanh ngay dưới tab | mọi nơi — cách dễ nhất trên điện thoại |
| Chuột phải vào tab hoặc thẻ session | desktop |
| **Giữ 0,5 giây** trên tab | điện thoại |
| `Ctrl+K` → *Tên và màu tab* | desktop |

Bảng này cũng có Restart, Kill và Đóng tab.

Tên, màu và chế độ đặt tên được lưu trong lịch sử, nên **mở lại một session cũ sẽ
khôi phục đúng màu và đúng cách đặt tên**.

API: `POST /api/sessions/:id/update` với `{ title, color, autoTitle }`.
Màu chỉ nhận đúng dạng `#rrggbb`, mọi giá trị khác bị bỏ.

---

## Desktop

- **Panel bên phải** chứa launcher, Files, Git, History, Máy, Diagnostics,
  Settings và danh sách session. Nút **▥** trên thanh trên cùng ẩn/hiện panel;
  trạng thái được nhớ lại. Muốn panel sang trái: **Settings → Đặt panel bên trái**.
- **🎤 và 🔊 nằm trên thanh trên cùng.** Bấm 🎤 sẽ tự hiện ô nhập lệnh để bạn thấy
  và sửa chữ vừa đọc trước khi gửi.
- Bình thường desktop gõ thẳng vào terminal nên ô nhập lệnh và hàng phím được ẩn.
  Bật cố định trong **Settings → Hiện ô nhập lệnh + phím tắt trên desktop**.

---

## Mobile

### Cuộn để xem lại kết quả

Kéo dọc trong vùng terminal để cuộn scrollback. Chạm (không kéo) vẫn được gửi
cho chương trình đang chạy, nên bấm chọn trong menu TUI vẫn hoạt động.

Vì sao phải tự làm: xterm chỉ cuộn bằng chạm khi **không** chương trình nào bật
mouse reporting. Claude Code, vim và less đều bật, nên đúng trong những session
mà app này sinh ra để phục vụ thì cú kéo bị chuyển thành sự kiện chuột gửi cho
chương trình và màn hình không nhúc nhích. App tách cử chỉ ở giai đoạn capture
trước khi xterm nhìn thấy: **chạm là của chương trình, kéo dọc là cuộn**. Khi đã
nhận ra là kéo thì cú nhả tay cũng bị giữ lại, để chương trình không hiểu nhầm
thành một cú click.

Ba thứ làm nó mượt:

- **Quán tính.** Vuốt nhanh rồi thả thì màn hình trượt tiếp và chậm dần, dừng khi
  hết đà hoặc chạm đầu/cuối buffer. Chạm tay xuống là dừng ngay.
- **Một lần ghi `scrollTop` mỗi khung hình.** Trước đây mỗi `touchmove` ghi một
  lần, bắt trình duyệt tính lại layout giữa cử chỉ.
- **Canvas renderer** (`@xterm/addon-canvas`). Không có addon nào thì xterm dựng
  lại toàn bộ dòng bằng DOM sau mỗi bước cuộn — đó là thứ điện thoại cảm nhận
  thành giật. Nếu trình duyệt từ chối context 2D thì tự quay về DOM renderer.

Giao diện mobile được thiết kế riêng, không phải desktop thu nhỏ:

```
[+] [tab] [tab] …            ⌘  ▤  ⋯
─────────────────────────────────────
Tên session
D:\du-an\bao-cao                  <- CWD luôn hiển thị
─────────────────────────────────────
Claude Assist  [Allow] [Deny] …      <- chỉ hiện khi nhận diện được
─────────────────────────────────────

           TERMINAL

─────────────────────────────────────
[ Nhập lệnh...                ] [↵]
─────────────────────────────────────
[↑] [↓] [Enter] [Esc] [Tab] [Ctrl+C] [Ctrl+Tab]
```

### Gõ tiếng Việt

Trên điện thoại bạn gõ vào **ô nhập lệnh** (`<textarea>` thật), không gõ thẳng
vào terminal. Lý do: IME (Telex/VNI, Gboard, bàn phím iOS) cần soạn thảo trên
một ô input thật; gửi từng ký tự vào PTY sẽ phá quá trình composition.

- `compositionstart` / `compositionend` được theo dõi; **Enter trong lúc IME
  đang soạn** thuộc về IME, ứng dụng không đụng vào.
- Nhấn Enter (khi không soạn) gửi trọn dòng + `\r` xuống PTY.
- `Shift+Enter` xuống dòng trong ô nhập.
- Ô nhập không bao giờ bị xoá giữa chừng.
- Font-size 16px để iOS không tự zoom.

**Bàn phím chỉ mở khi bạn chạm vào ô nhập lệnh.** Chạm vào vùng terminal là để
đọc và bôi đen, không phải để gõ — bàn phím bật lên ở đó sẽ che đúng phần chữ
bạn vừa chạm vào để xem. Cụ thể:

- `textarea.xterm-helper-textarea` (ô ẩn xterm dùng bắt phím) bị đặt
  `readOnly` + `inputmode="none"` + `tabindex="-1"` trên mobile, nên iOS không
  mở bàn phím cho nó.
- Chuyển tab, bấm Esc/Tab/mũi tên, bấm nút gửi, hay đọc chính tả đều **không**
  gọi bàn phím lên: `refocusInput()` chỉ *khôi phục* focus khi bàn phím đang mở
  sẵn (`body.keyboard-open`), chứ không bao giờ tự mở.

Trên desktop bạn gõ thẳng vào terminal (xterm). Muốn hiện ô nhập + hàng phím
trên desktop: **Settings → Hiện ô nhập lệnh + phím tắt trên desktop**.

### Phím terminal

Hàng phím ưa thích tối đa **8 phím**, cấu hình trong *⚙ Cấu hình phím*, lưu ở
`localStorage`. Mặc định: `↑ ↓ Enter Esc Tab Ctrl+C Ctrl+Tab`.

Đầy đủ các phím hỗ trợ: Up, Down, Left, Right, Enter, Esc, Tab, Shift+Tab,
Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+R, Ctrl+Z, Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+W, Home,
End, PageUp, PageDown, Space, Backspace, Ctrl+Tab, Shift+Ctrl+Tab.

### Phím tắt desktop

| Phím | Tác dụng |
|---|---|
| `Ctrl+K` | Command palette |
| `Alt+1..9` | Chọn tab thứ N |
| `Ctrl+PageUp` / `Ctrl+PageDown` | Đổi tab |
| `Ctrl+Tab` | Đổi tab *nếu trình duyệt cho phép* |

> Chrome/Edge giữ `Ctrl+Tab` cho chính nó và web không chặn được. Vì vậy luôn có
> nút **Ctrl+Tab** trên hàng phím và `Alt+số` làm phương án thay thế — chức năng
> đổi tab của ứng dụng không bao giờ bị trình duyệt phá.

---

## Claude Code từ xa

Bấm **Claude Code** ở sidebar (hoặc `Ctrl+K` → *New Claude Code*). Ứng dụng mở
một PowerShell thật trong ConPTY rồi **gõ lệnh `claude` vào chính PTY đó**, y
như bạn tự gõ. Không có wrapper, không `exec()`, không giả lập giao thức Claude.

Đường dẫn `claude` được dò tự động; ép bằng `CLAUDE_BIN`.

### Ba tầng điều khiển

| Tầng | Là gì | Khi nào dùng |
|---|---|---|
| **1 — Raw** | Bàn phím / ô nhập → thẳng vào PTY | luôn luôn |
| **2 — TUI** | Nút `↑ ↓ Enter Esc Tab` | mọi TUI, luôn an toàn |
| **3 — Claude Assist** | Nút thật cho từng lựa chọn | khi nhận diện chắc chắn |

Claude Assist đọc **buffer đã render của xterm** (ANSI đã được xterm diễn giải;
luồng raw gửi tới terminal không bị đụng vào). Nó nhận ra:

- menu có con trỏ: `❯ Allow / Deny / Cancel` → bấm nút = gửi đúng số lần
  `↑`/`↓` rồi `Enter`;
- menu đánh số `1. … 2. …` → gửi đúng chữ số;
- câu hỏi `(y/n)` → gửi `y`/`n` + Enter.

Quy tắc an toàn: **chỉ tự gửi phím khi biết chắc mục nào đang được chọn**
(đúng một dòng được highlight, và các dòng option thẳng cột với nhau). Không
chắc → thanh Assist chuyển sang hiển thị `↑ ↓ Enter Esc` để bạn tự bấm. Sai còn
tệ hơn không tự động.

Tắt/bật trong **Settings → Bật Claude Assist**.

---

## Lịch sử session

Mọi terminal từng mở đều được ghi lại. Bấm **🕘 History** (hoặc `Ctrl+K` →
*Lịch sử session*) để xem danh sách, tìm theo tên/thư mục, và bấm một dòng để
**mở lại đúng shell tại đúng thư mục lúc nó đóng**.

- Lưu ở `.data/session-history.json` trên máy sở hữu session, nên sống sót qua
  restart web server và đi theo đúng máy (máy từ xa báo lịch sử của chính nó).
- Chỉ lưu metadata: tên, shell, thư mục, thời điểm, mã thoát. **Không** lưu nội
  dung terminal, không lưu phím bạn gõ.
- Giữ tối đa 500 mục gần nhất; xoá từng mục bằng nút 🗑.
- Nếu thư mục cũ không còn, session vẫn mở nhưng ở thư mục mặc định và app báo rõ.

API: `GET /api/history` · `POST /api/history/:id/reopen` · `DELETE /api/history/:id`

---

## Nhật ký hội thoại với agent

Khi một session chạy Claude Code hoặc Antigravity, app ghi lại hội thoại vào
**chính thư mục làm việc của session**:

| Agent | File |
|---|---|
| Claude Code | `.claudehis.txt` |
| Antigravity | `.agyhis.txt` |

Định dạng:

```text
===== CLAUDE session 42f85be... started 2026-08-30 03:05:45 =====
cwd: D:\du-an\bao-cao
shell: powershell

--- YOU  2026-08-30 03:05:47
làm tiếp

--- CLAUDE  2026-08-30 03:06:02
Đã thêm tính năng XYZ vào src/main.js
...
```

Nhận diện tự động khi bạn gõ `claude`, `antigravity` hoặc `agy` — kể cả gõ tay
trong một PowerShell bình thường, không chỉ khi bấm nút launcher.

**Giới hạn cần biết:** phần *bạn gõ* là chính xác vì lấy thẳng từ luồng input.
Phần *agent trả lời* lấy từ output của PTY, đã bóc ANSI và gộp các khung vẽ lặp
lại. Claude Code là TUI toàn màn hình vẽ đi vẽ lại liên tục, nên đó là bản ghi
"những gì đã hiện trên màn hình" đã được làm sạch — đọc và tìm kiếm được, nhưng
không phải transcript theo cấp giao thức, và không thể là như vậy nếu công cụ
không cung cấp API. Luồng gửi cho trình duyệt không bị đụng tới; module này chỉ
đọc một bản sao.

Nếu thư mục làm việc không ghi được, file rơi về `.data/agent-logs/`.

---

## Nhiều máy

Điều khiển terminal trên nhiều máy trong LAN từ một giao diện.

### Máy nào chạy cái gì

| | Web server (8080) | PTY host (8777) |
|---|---|---|
| Máy điều khiển — nơi bạn mở trình duyệt | **có** | có (cho session của chính nó) |
| Máy từ xa, ví dụ 192.168.192.42 | **không cần** | **có, đây là cái duy nhất cần chạy** |

Máy 42 **không chạy web server và không mở cổng 8080**. Nó chỉ chạy PTY host và
lắng nghe **TCP 8777** (đổi bằng `PTY_HOST_PORT`). Trình duyệt của bạn vẫn chỉ
nói chuyện với máy điều khiển; máy điều khiển mới là bên mở kết nối tới 8777 của
máy 42.

```text
iPhone ──HTTPS──> máy điều khiển :8080 ──TCP 8777──> máy 192.168.192.42
```

### Trên máy 42 — một lệnh

```powershell
cd C:\path\den\wt
.\scripts\start-remote-host.ps1 -AllowFirewall -FromSubnet 192.168.192.0/24
```

Script sẽ: bind PTY host vào `0.0.0.0`, khởi động nó, mở firewall cho TCP 8777
giới hạn trong subnet bạn chỉ định, in ra các IP của máy đó và **in ra key**.

Chạy `-AllowFirewall` cần PowerShell Administrator. Bỏ cờ đó thì script chỉ in
sẵn câu lệnh firewall để bạn tự chạy.

Muốn máy 42 tự chạy sau khi reboot: `.\scripts\install-service.ps1` trên máy đó
rồi đặt `PTY_HOST_BIND=0.0.0.0` ở machine level — task `WebTerminal-Web` có thể
disable vì máy 42 không cần web server.

### Làm thủ công (nếu không dùng script)

```powershell
[Environment]::SetEnvironmentVariable("PTY_HOST_BIND","0.0.0.0","Machine")
[Environment]::SetEnvironmentVariable("PTY_HOST_PORT","8777","Machine")
New-NetFirewallRule -DisplayName "Web Terminal PTY host" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8777 -RemoteAddress 192.168.192.0/24
node server\pty-host.js
node scripts\host-key.js     # copy key
```

### Trên máy Linux

Máy Linux chỉ chạy PTY host, y như máy Windows từ xa. Cần Node 18+ và một trình
biên dịch, vì `node-pty` là native module và **phải build trên chính máy đó** —
copy `node_modules` từ máy khác sang sẽ không chạy.

```bash
sudo apt install -y build-essential python3    # Debian/Ubuntu
git clone <repo> web-terminal && cd web-terminal
npm ci
./scripts/start-remote-host.sh
```

Script kiểm tra Node, kiểm tra `node-pty` nạp được, liệt kê shell tìm thấy, từ
chối chạy nếu cổng đã có chủ, in ra IP và **in ra key** để bạn dán sang máy điều
khiển.

Shell hỗ trợ: **bash**, **zsh**, **sh**.

Theo dõi thư mục (đặt tên tab theo `cd`) dùng OSC 9;9, cài bằng một file rc nhỏ
trong `.data/shell-init/` — file đó **source `.bashrc` / `.zshrc` của bạn trước**
rồi mới thêm hook, nên cấu hình shell của bạn không bị mất. zsh móc qua `ZDOTDIR`
vì zsh không có `--rcfile`. `sh` không có `PROMPT_COMMAND` lẫn `precmd` nên không
theo dõi được thư mục — tab giữ nguyên tên; hãy dùng bash hoặc zsh.

Chạy nền sau khi reboot:

```bash
sudo cp scripts/web-terminal-host.service /etc/systemd/system/
sudo systemctl edit --full web-terminal-host   # sửa User= và WorkingDirectory=
sudo systemctl enable --now web-terminal-host
```

Unit chạy dưới **user thường**, không phải root: shell mở ra kế thừa quyền của
tiến trình này, nên root ở đây nghĩa là root shell cho bất kỳ ai giữ key.

### Trên máy điều khiển

Sidebar → **🖧 Máy** → Tên `May 42`, Địa chỉ `192.168.192.42`, Cổng `8777`,
dán key → **Kiểm tra kết nối** → **Thêm máy**.

Sau đó dialog **Terminal mới** có ô chọn **Máy**, thẻ session hiện tên máy, và
mọi thao tác (gõ, resize, kill, restart, lịch sử) được định tuyến tới đúng máy.

Lưu ý:

- Kết nối giữa hai máy được **mã hoá bằng TLS-PSK** (TLS 1.2, bộ mã PSK), khoá
  lấy từ chính `.data/host.key` của máy đó. Không có chứng chỉ nào phải tạo hay
  phải tin: khoá mà liên kết vốn đã dùng để xác thực giờ cũng là khoá mã hoá.
  Key sai rớt ngay ở bước bắt tay, chưa vào tới giao thức. Vẫn nên giữ trong LAN
  hoặc VPN; đừng định tuyến ra Internet.
- **Máy chạy bản cũ** (trước khi có mã hoá) chỉ nói được giao thức thô. Đánh dấu
  nó bằng `node scripts\machines.js tls <id|tên|số> off`, nâng cấp xong thì
  `... on`. Muốn tắt mã hoá cho chính máy này thì đặt `PTY_HOST_TLS=0` rồi khởi
  động lại PTY host — cả hai cách đều đưa terminal trở lại dạng đọc được trên
  đường truyền, nên chỉ dùng tạm.
- Key nằm ở `.data/host.key`, ai có key là mở được terminal trên máy đó — coi nó
  như mật khẩu.
- Bộ chọn thư mục và File Explorer chỉ làm việc trên máy chạy web server. Với máy
  từ xa hãy gõ thẳng đường dẫn vào ô thư mục.
- Tối đa 12 máy. Danh sách lưu ở `.data/hosts.json`.

### Mọi máy ngang hàng — đổi máy chính

Trong `.data/hosts.json` **mọi máy đều là một dòng như nhau**, kể cả máy đang
chạy web: id, tên, địa chỉ, cổng, key. "Máy chính" không được ghi ở đâu cả — web
server lúc khởi động tự tìm chính nó trong danh sách, theo id máy lấy từ hệ điều
hành (MachineGuid trên Windows, `/etc/machine-id` trên Linux), hoặc theo key của
nó với danh sách cũ. Nên cùng một file đọc ở máy nào cũng đúng: ở máy 231 thì
231 là máy chính, ở máy 42 thì 42.

Id, tên và thứ tự đi theo file, nên chuyển máy chính rồi thì tab, lịch sử và
hình trên tab (1 tròn, 2 tam giác, 3 vuông...) của từng máy vẫn y như cũ.

Chuyển máy chính sang 42:

```powershell
# trên máy chính hiện tại
node scripts\machines.js export Z:\chuyen\web-terminal-group.json

# trên máy 42 (code đã pull + build, web server chưa chạy)
node scripts\machines.js import C:\chuyen\web-terminal-group.json
.\scripts\resume.ps1
```

File export gồm danh sách máy, tài khoản (`users.json`) và các tab đã lưu
(`workspaces.json`). Nó **chứa key của mọi máy** — chép qua đường tin cậy rồi
xoá. Không mang theo `host.key` (mỗi máy giữ key riêng) và `secret.key`.

Để máy chính mới điều khiển được các máy còn lại, PTY host của các máy đó phải
nghe trên LAN. `resume.ps1` tự bind `0.0.0.0` khi danh sách có máy khác (`-LocalOnly`
để tắt) và in sẵn lệnh mở firewall, giới hạn đúng địa chỉ các máy trong nhóm. PTY
host đang chạy chỉ ở `127.0.0.1` thì phải `-Restart` — **đóng mọi terminal trên máy
đó**.

`node scripts\machines.js` (không tham số) liệt kê nhóm và đánh dấu máy này.
Địa chỉ của máy này được lấy từ chính kết nối nó mở tới máy khác; nếu đoán sai,
đặt `WEB_TERMINAL_ADDRESS`.

### Đặt máy chính ở máy ít khởi động lại nhất

Điều quyết định: **khởi động lại web server không làm mất terminal nào** — nó chỉ
là cái hiển thị. Chỉ PTY host mới giữ các phiên ConPTY, nên chỉ khi nó chết mới
mất terminal. Vì vậy máy chính nên là máy bạn ít tắt/khởi động lại nhất, và trên
máy đó hai tiến trình phải được tách rõ vai:

| Tiến trình | Khởi động lại | Khi nào cần chạm tới |
|---|---|---|
| PTY host | **mất mọi terminal của máy đó** | chỉ khi đổi `server/profiles.js`, đổi `PTY_HOST_BIND`/`PTY_HOST_TLS`, hoặc nâng cấp code phần PTY |
| Web server | không mất gì | mọi thay đổi khác: giao diện, API, cấu hình web, HSTS, sau `git pull` |

Cài thường trú (chạy lại sau khi Windows khởi động, tự chạy lại khi lỗi):

```powershell
node scripts\hash-password.js "mat khau manh"     # lấy hash
.\scripts\install-service.ps1 -PasswordHash "scrypt$..." -Roots "D:\work"
```

Nó tạo hai Scheduled Task — `WebTerminal-PtyHost` rồi `WebTerminal-Web` sau 20
giây — và đọc cấu hình từ biến môi trường **mức Machine** để cả hai cùng thấy.

Đừng chạy dưới SYSTEM (`-RunAsSystem`, và `install-pty-host-task.ps1` mặc định là
SYSTEM) nếu bạn dùng agent trên máy đó: agent lấy thông tin đăng nhập từ profile
người dùng (`~/.claude`, `~/.codex`), chạy dưới SYSTEM là mất hết, và mọi terminal
sẽ có quyền SYSTEM. Chạy dưới đúng tài khoản bạn vẫn làm việc.

Sau khi chuyển, nhớ ba thứ đi theo máy chính:

1. **Cloudflare tunnel** trỏ về web server của máy chính mới, không phải máy cũ.
2. **Kênh mã hoá**: trên máy chính mới, bật cờ cho từng máy còn lại khi máy đó đã
   chạy bản có TLS — `node scripts\machines.js tls <id|tên|số> on` (xem [Nhiều
   máy](#nhiều-máy)).
3. **Agent bạn dùng để phát triển chính dự án này** nên chạy ngay trên máy chính:
   sửa code xong thì chỉ cần khởi động lại web server, không phải với sang máy
   khác, và không phải restart PTY host vốn đang giữ các terminal của bạn.

Máy cũ không mất vai trò gì: nó vẫn là một dòng trong `hosts.json`, terminal trên
nó vẫn mở được từ giao diện của máy chính mới, miễn PTY host của nó nghe trên LAN.

---

## Giọng nói

Trên desktop hai nút nằm ở thanh trên cùng; trên điện thoại chúng nằm cạnh ô
nhập lệnh:

| Nút | Việc |
|---|---|
| 🎤 | Bật/tắt đọc chính tả — nói xong chữ hiện vào ô lệnh, bạn xem lại rồi bấm ↵ |
| 🔊 | Đọc to kết quả của lệnh vừa gửi; bấm lại để dừng |

Nói **"đọc kết quả"** (hoặc "doc ket qua", "read the result") trong lúc đọc chính
tả sẽ **không** bị gõ vào ô lệnh mà kích hoạt luôn việc đọc kết quả.

Ngôn ngữ nhận dạng mặc định là `vi-VN`, đổi trong **Settings → Ngôn ngữ giọng
nói**.

### Đọc phần nào

Chỉ đọc **output của lệnh cuối cùng** — tính từ dòng echo lệnh đó trở xuống.

Khi terminal đang chạy Claude Code, màn hình có ba loại nội dung lẫn vào nhau và
chỉ loại đầu được đọc:

| Nội dung | Dấu hiệu trên màn hình | Đọc? |
|---|---|---|
| Câu trả lời hiển thị | `● <chữ>` và các dòng nối tiếp | ✅ |
| Suy luận | `✻ Thinking…` + khối thụt lề dưới nó | ❌ |
| Lệnh công cụ và kết quả | `● Bash(...)`, `⎿ ...` | ❌ |
| Spinner, `? for shortcuts`, ô nhập | `(esc to interrupt)`, khung `╭─│─╯` | ❌ |

Terminal thường (không phải Claude) vẫn đọc như cũ: mọi dòng sau lệnh, bỏ prompt
và ký tự khung.

### Hai engine đọc

**Settings → Giọng đọc kết quả**:

| Engine | Khi nào dùng |
|---|---|
| **VieNeu** (mặc định) | Đọc lẫn Việt + Anh trong cùng một câu bằng một giọng — hợp với câu kiểu "đã chạy npm test, 98 test pass" |
| Giọng trình duyệt | Khi không chạy VieNeu; mỗi giọng chỉ đúng một ngôn ngữ |

VieNeu chạy ở máy server, cạnh PTY host, và **đi qua proxy của app** — điện thoại
không gọi thẳng vào nó, nên không phải mở thêm cổng ra mạng:

```
điện thoại  →  POST /api/tts  →  web server  →  127.0.0.1:8001 /stream  →  VieNeu
```

Chạy VieNeu (repo [VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS)):

```powershell
$env:PYTHONUTF8 = "1"          # nếu thiếu, print emoji của VieNeu vỡ trên cp1252
uv run vieneu-stream           # nghe ở 127.0.0.1:8001
```

Biến môi trường phía web server:

| Biến | Mặc định | Việc |
|---|---|---|
| `VIENEU_TTS_URL` | `http://127.0.0.1:8001` | Địa chỉ VieNeu |
| `WEB_TERMINAL_TTS` | `1` | `0` = tắt hẳn, chỉ dùng giọng trình duyệt |
| `WEB_TERMINAL_TTS_TIMEOUT_MS` | `120000` | Hạn chờ mỗi đoạn |
| `WEB_TERMINAL_TTS_MAX_CHARS` | `2000` | Cắt bớt trước khi gửi (VieNeu giới hạn 3000) |

Không chạy VieNeu thì nút 🔊 vẫn đọc: app báo một dòng rồi tự lùi về giọng của
trình duyệt.

### Chạy VieNeu-TTS

Dùng bản VieNeu có chế độ Turbo (ONNX, chạy trên CPU, 48 kHz), trong môi trường Python riêng của nó:

```powershell
$env:PYTHONIOENCODING = "utf-8"
python -m apps.web_stream        # nghe trên http://127.0.0.1:8001
```

App tự nhận ra và bật giọng VieNeu trong **Settings → Giọng VieNeu**. Không chạy thì nút 🔊
vẫn đọc bằng giọng trình duyệt kèm thông báo.

Chi tiết kỹ thuật cần biết:

- Đọc chính tả dùng Web Speech API. Hỗ trợ trên Chrome và Safari iOS từ 14.5,
  cần HTTPS và một thao tác chạm để bắt đầu.
- **Âm thanh được gửi tới dịch vụ của Apple hoặc Google để nhận dạng**, không xử
  lý cục bộ và không đi qua server của app. Nếu điều đó không chấp nhận được thì
  đừng dùng nút micro.
- Phần đọc to bằng `speechSynthesis` chạy cục bộ trên thiết bị. Giọng tiếng Việt
  phụ thuộc thiết bị; iOS có sẵn, Windows cần cài thêm giọng vi-VN.
- Nội dung đem đọc cắt ở 3000 ký tự.
- Với VieNeu, câu trả lời được **cắt thành từng câu ~220 ký tự**: đoạn sau được
  tổng hợp trong lúc đoạn trước đang phát, nên chờ khoảng một câu chứ không chờ
  cả bài.
- VieNeu stream WAV với header khai 100 triệu frame vì lúc gửi header chưa biết
  độ dài. Chrome bỏ qua, **iOS Safari thì từ chối phát**. Nên `server/tts.js`
  đệm trọn đoạn, ghi lại header đúng kích thước rồi trả kèm `Content-Length`.
- iOS chỉ cho phát tiếng từ trong một thao tác chạm. App giữ **một** phần tử
  `Audio` cho cả phiên và "mở khoá" nó ngay ở cú chạm đầu tiên (nút 🔊 hoặc 🎤),
  nhờ đó các đoạn phát sau vẫn chạy dù đã `await` qua mạng.

---

## Session bền vững

| Sự kiện | Session |
|---|---|
| Đóng tab / khoá điện thoại | **sống** |
| Mất mạng, mở lại | **sống**, tự attach lại + phát lại scrollback |
| Restart web server (`npm start`, deploy, sửa code) | **sống** |
| Restart PTY host | chết |
| Reboot Windows | chết (xem [Giới hạn](#giới-hạn-đã-biết)) |

PTY host giữ **ring buffer scrollback** (mặc định 512 KB/session). Khi trình
duyệt attach lại, server phát lại nguyên vẹn phần buffer đó nên terminal hiện ra
đúng chỗ bạn đã bỏ dở — kể cả sau khi web server đã được restart.

Session đã thoát vẫn nằm trong danh sách 30 phút để bạn kịp bấm **Restart**
(giữ nguyên id và tab).

---

## API

Server là nguồn sự thật duy nhất về session; trình duyệt không tự quyết định gì.

### Session

| Method | Đường dẫn | Mô tả |
|---|---|---|
| `GET` | `/api/sessions` | liệt kê |
| `POST` | `/api/sessions` | tạo `{shell, cwd, title, cols, rows, autoRun}` |
| `POST` | `/api/sessions/:id/attach` | trả `{session, history}` |
| `POST` | `/api/sessions/:id/restart` | giữ id, tiến trình mới |
| `POST` | `/api/sessions/:id/kill` | kill tiến trình, giữ bản ghi |
| `POST` | `/api/sessions/:id/rename` | đổi tên tab |
| `POST` | `/api/sessions/:id/resize` | `{cols, rows}` |
| `DELETE` | `/api/sessions/:id` | xoá hẳn |

Mỗi session có: `id, title, shell, cwd, pid, createdAt, lastAttachedAt, status,
exitCode, cols, rows`.

### Thư mục (chọn nơi mở terminal)

`GET /api/dirs?path=` — liệt kê **tên thư mục con** (không có file). Bỏ trống
`path` thì trả về danh sách ổ đĩa. Đi được tới mọi thư mục **trừ thư mục hệ
thống Windows**, và không đọc/ghi/xoá được nội dung file nào.

### File

`GET /api/files?path=` · `POST /api/files/mkdir` · `POST /api/files/rename` ·
`POST /api/files/delete` · `GET /api/download?path=` · `POST /api/upload?path=`
(tên file ở header `X-File-Name`, đã percent-encode).

### Git (chỉ đọc)

`GET /api/git/status?cwd=` · `GET /api/git/branches?cwd=` ·
`GET /api/git/log?cwd=&limit=`

Không có endpoint nào commit/push. Muốn commit thì gõ trong terminal.

### Máy và lịch sử

`GET /api/hosts` · `POST /api/hosts` · `DELETE /api/hosts/:id` ·
`POST /api/hosts/probe` · `GET /api/history` ·
`POST /api/history/:entryId/reopen` · `DELETE /api/history/:entryId`

### Khác

`POST /api/login` · `POST /api/logout` · `GET /api/config` · `GET /api/profiles`
· `GET /health` (public) · `GET /api/system`

### WebSocket `/terminal`

Một kết nối duy nhất, ghép kênh mọi terminal.

Gửi lên: `{type:"attach"|"detach"|"input"|"resize"|"ping", sessionId, …}`
Nhận về: `ready`, `sessions`, `history`, `output`, `exit`, `cwd`, `reset`,
`hostState`, `error`, `pong`.

---

## Cấu hình (biến môi trường)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `8080` | cổng web |
| `HOST` | `0.0.0.0` | địa chỉ bind |
| `PTY_HOST_PORT` | `8777` | cổng PTY host |
| `PTY_HOST_BIND` | `127.0.0.1` | đặt `0.0.0.0` để máy khác trong LAN điều khiển được (`resume.ps1` tự đặt khi nhóm có máy khác) |
| `PTY_HOST_TLS` | `1` | mã hoá kênh giữa các máy bằng TLS-PSK (`server/tlspsk.js`); `0` = giao thức thô, chỉ để nói với máy chạy bản cũ |
| `WEB_TERMINAL_HSTS_DAYS` | `0` | số ngày Strict-Transport-Security; để `0` khi còn vào bằng quick tunnel (tên miền dùng chung) |
| `WEB_TERMINAL_ADDRESS` | tự tìm | địa chỉ các máy khác dùng để tới máy này, khi tự tìm sai |
| — | — | máy từ xa **chỉ** cần PTY host (8777), không cần web server |
| `WEB_TERMINAL_PASSWORD_HASH` | — | hash scrypt (khuyến nghị) |
| `WEB_TERMINAL_PASSWORD` | `123123` | mật khẩu thô; đặt rỗng để tắt xác thực |
| `WEB_TERMINAL_ROOTS` | `%USERPROFILE%` | thư mục file manager được phép, ngăn bằng `;` |
| `WEB_TERMINAL_BLOCKED_DIRS` | — | thư mục cấm mở terminal, thêm vào danh sách mặc định |
| `WEB_TERMINAL_DATA` | `.\.data` | secret key + log |
| `WEB_TERMINAL_MAX_UPLOAD_MB` | `200` | giới hạn upload |
| `WEB_TERMINAL_SCROLLBACK_KB` | `512` | scrollback giữ mỗi session |
| `WEB_TERMINAL_MAX_SESSIONS` | `0` (không giới hạn) | trần số session chạy đồng thời, nếu muốn đặt |
| `WEB_TERMINAL_EXITED_KEEP_MIN` | `30` | giữ session đã thoát bao lâu |
| `WEB_TERMINAL_TOKEN_HOURS` | `168` | hạn token đăng nhập |
| `WEB_TERMINAL_TLS_CERT` / `_KEY` | — | bật HTTPS trực tiếp |
| `WEB_TERMINAL_TRUST_PROXY` | `1` | tin `X-Forwarded-For` |
| `WEB_TERMINAL_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `CLAUDE_BIN` | dò tự động | đường dẫn `claude` |

---

## Logging & Diagnostics

Log JSON-lines, một file mỗi ngày, trong `.data\logs\`:

```
web-2026-08-28.log
pty-host-2026-08-28.log
```

Ghi lại: session created/attached/detached/killed/exit, process exit, lỗi
WebSocket, đăng nhập sai, upload/download, lỗi Git API, request 4xx/5xx.

**Không** ghi: mật khẩu, token, nội dung gõ vào terminal, output của terminal.
Các khoá `password/token/secret/authorization/cookie/data/input` bị redact tự động.

`GET /api/system` và **Settings → Diagnostics** cho biết: Node version, Windows,
trạng thái + pid + uptime của web server và PTY host, số session, số WebSocket
client, bộ nhớ, roots, và 60 dòng log gần nhất.

---

## Bảo mật

Đây là giao diện thực thi lệnh từ xa. Đã xử lý:

| Rủi ro | Cách chặn |
|---|---|
| Path traversal `..\` | `safePath()` resolve + theo symlink, phải nằm trong roots |
| Escape bằng symlink/junction | so sánh sau `realpathSync.native` |
| Đường dẫn UNC `\\server\share` | từ chối |
| Tên file độc `..\..\x.txt`, `CON` | `safeName()` bỏ thư mục, chặn tên dành riêng |
| Command injection qua Git | `execFile` với mảng tham số, `shell:false` |
| CSRF | bắt buộc header `X-WT-Client` cho mọi method thay đổi |
| WebSocket hijack | kiểm tra `Origin` + token/cookie khi upgrade |
| Attach session không phận sự | `input`/`resize` chỉ chấp nhận sau khi attach |
| JSON/WS rác | try/catch mọi nơi, trả lỗi JSON, không chết server |
| Upload quá lớn | chặn theo `Content-Length` **và** đếm byte thực nhận |
| Brute-force mật khẩu | throttle theo IP, backoff luỹ tiến |
| Flood WebSocket | > 2000 message/5s là đóng kết nối |
| Resize bậy | clamp 20–500 cột, 5–200 dòng |
| Session id bậy | tra map, trả "Session not found" |

### Hai ranh giới khác nhau

| | Phạm vi | Vì sao |
|---|---|---|
| **Thư mục mở terminal** | mọi nơi trừ thư mục hệ thống Windows | shell chạy rồi thì `cd` đi đâu cũng được, khoá thư mục khởi đầu không thêm an toàn mà chỉ vướng |
| **File manager** (duyệt/tải/upload/xoá) | chỉ trong `WEB_TERMINAL_ROOTS` | đây mới là chỗ thực sự đọc ghi dữ liệu |

Nhật ký agent ghi vào thư mục làm việc của session (ngoài roots nếu session ở
ngoài roots) — đó là yêu cầu của tính năng; nó do PTY host ghi, không đi qua
file API. Liên kết giữa các máy mã hoá bằng TLS-PSK, xem [Nhiều máy](#nhiều-máy).

Chặn mặc định: `%SystemRoot%` (C:\Windows), `$Recycle.Bin`,
`System Volume Information`, `Recovery`, `Boot`, `PerfLogs`, `Config.Msi`,
`Documents and Settings`. Thêm bằng `WEB_TERMINAL_BLOCKED_DIRS` (ngăn bằng `;`).

Vẫn phải tự làm:

- **Đổi mật khẩu mặc định `123123`** trước khi cho truy cập từ ngoài.
- Đừng đặt `WEB_TERMINAL_ROOTS=C:\`.
- Chạy bằng tài khoản Windows riêng, quyền tối thiểu.
- Chỉ mở cổng cho LAN/VPN, hoặc dùng Cloudflare Tunnel + Access.
- Dùng HTTPS trước khi ra khỏi mạng tin cậy.

---

## Testing

```powershell
npm test              # 178 test
npm run test:unit     # chỉ test thuần, chạy nhanh
```

Bộ test bật **PTY host thật + web server thật** trên cổng ngẫu nhiên, spawn
ConPTY thật, và kiểm tra:

- tạo/liệt kê/rename/restart/kill/xoá session, có pid thật;
- gõ lệnh qua WebSocket và đọc output thật của tiến trình;
- **session sống sót qua restart web server và scrollback được phát lại**;
- restart giữ nguyên id nhưng đổi pid;
- đăng nhập sai/đúng, token bị thu hồi sau logout, chặn CSRF;
- path traversal, download/upload ngoài roots, tên file độc;
- mkdir/rename/delete, từ chối xoá chính root;
- Git status trong và ngoài repo;
- WebSocket: message rác, attach session không tồn tại, input khi chưa attach;
- heuristic Claude Assist: nhận đúng menu, **từ chối đoán khi không chắc**,
  không báo nhầm trên output bình thường;
- bộ chọn thư mục: liệt kê ổ đĩa, đi ra ngoài roots được, **không** liệt kê
  file, từ chối thư mục hệ thống, bắt buộc đăng nhập;
- tạo terminal ở thư mục ngoài roots thành công, ở `C:\Windows` bị từ chối;
- lịch sử: ghi lại session, sống sót khi xoá session và khi restart web server,
  mở lại đúng thư mục, và **báo đúng khi thư mục cũ đã mất**;
- nhật ký agent: gõ `claude` tạo `.claudehis.txt` đúng thư mục, ghi đúng câu
  bạn gõ và output thật, **không có ký tự ANSI**; session thường không tạo file;
- nhiều máy: dựng một PTY host thứ hai làm "máy khác", thêm bằng key, tạo
  session trên đó, gõ lệnh và nhận output từ máy đó, rồi gỡ máy;
- giọng nói: phân biệt "đọc kết quả" với câu đọc chính tả; trích đúng phần kết
  quả để đọc (bỏ prompt, bỏ dòng lặp); với màn hình Claude Code thì giữ phần
  hiển thị và bỏ khối suy luận, lệnh công cụ, spinner; bắt đầu từ lệnh cuối chứ
  không phải lệnh trước đó, và không nhầm chữ còn nằm trong ô nhập là đã gửi;
  cắt câu cho TTS không mất chữ; WAV stream được ghi lại header đúng độ dài;
- tab: tên lấy đúng thư mục (`Test`, `C:\`), đổi theo `cd`, tên đặt tay thì
  được ghim, xoá tên thì trả về tự động; màu chỉ nhận `#rrggbb` và được khôi
  phục khi mở lại từ lịch sử.

---

## Troubleshooting

**Trang trắng / UI cũ** — chưa build: `npm run build`. Không có `dist\index.html`
server sẽ fallback về `public\`.

**"PTY host offline"** — xem `.data\logs\pty-host-*.log`; kiểm tra cổng 8777:
`.\scripts\status.ps1`. Web server tự spawn lại host mỗi vài giây.

**WebSocket không kết nối sau reverse proxy** — proxy phải chuyển tiếp
`Upgrade`/`Connection`. Nginx: `proxy_set_header Upgrade $http_upgrade;` và
`proxy_set_header Connection "upgrade";`. IIS cần bật WebSocket Protocol.

**Đăng nhập xong lại bị đá ra** — `.data\` không ghi được nên secret key đổi mỗi
lần khởi động. Cấp quyền ghi cho tài khoản chạy service.

**Terminal không mở, "Shell not available"** — shell đó không có trên máy.
`GET /api/profiles` liệt kê shell thực sự tìm thấy.

**Session mất sau khi reboot** — đúng như thiết kế; xem mục dưới.

**Tiếng Việt hiện dấu `?` khi gõ** — chỉ xảy ra nếu snippet khởi tạo PowerShell
không chạy được. Kiểm tra bằng `[Console]::OutputEncoding` trong session đó.

**Ctrl+Tab không đổi tab** — Chrome/Edge giữ phím này. Dùng nút Ctrl+Tab trên
hàng phím, hoặc `Alt+1..9`, hoặc `Ctrl+PageUp/PageDown`.

**`start-remote-host.ps1` báo "did not come up" trên máy mới** — hầu như luôn là
`node-pty`. `server/pty-host.js` gọi `require("node-pty")` trước khi mở log, nên
khi module native đó không nạp được thì tiến trình chết mà **không ghi log nào**
— đúng file mà thông báo cũ bảo bạn đi xem. Script bây giờ tự kiểm tra trước và
in luôn lỗi thật:

```powershell
npm ci                 # dependencies chưa cài trên máy này
npm rebuild node-pty   # đã cài nhưng build cho bản Node khác
```

Muốn xem tận mắt: `node server\pty-host.js` (chạy nổi, lỗi hiện ngay trên console).

**`git pull` báo `fatal: bad object refs/desktop.ini`** — Windows Explorer đã tạo
file `desktop.ini` bên trong `.git\refs\`. Git coi mọi file dưới `refs/` là một
ref, nên nó cố đọc `desktop.ini` như một commit id và hỏng cả phiên fetch
(`did not send all necessary objects` là hệ quả, không phải lỗi của remote).

```powershell
Get-ChildItem .git -Recurse -Force -Filter desktop.ini | Remove-Item -Force
git fsck --no-dangling      # kiểm tra lại
git pull
```

Nó sinh ra khi thư mục được Explorer tuỳ biến (đổi icon, đổi kiểu xem) hoặc do
một trình đồng bộ. Nếu repo nằm trong thư mục được đồng bộ thì nó sẽ quay lại —
loại `.git` ra khỏi phạm vi đồng bộ là cách chặn tận gốc.

---

## Giới hạn đã biết

- **Reboot Windows kết thúc mọi session.** Windows/ConPTY không có
  checkpoint/restore tiến trình. Scheduled Task chỉ bảo đảm PTY host chạy lại
  sau khi boot để bạn tạo session mới; một phiên Claude Code đang chạy không thể
  được khôi phục.
- **Emoji trong Windows PowerShell 5.1.** Khi console 5.1 chạy UTF-8 (bắt buộc
  để PSReadLine vẽ đúng tiếng Việt lúc bạn gõ), gõ ký tự astral (emoji) làm
  PSReadLine ném `EncoderFallbackException` khi ghi history: nó in ra một khối
  "Oops, something went wrong" nhưng **lệnh vẫn chạy và session vẫn sống**. Đây
  là lỗi của PSReadLine/PowerShell 5.1, không sửa được từ ứng dụng này. Tiếng
  Việt hoàn toàn không bị ảnh hưởng. PowerShell 7 không dính lỗi này và xử lý cả
  tiếng Việt lẫn emoji đúng — dùng `pwsh` nếu bạn cần emoji.
- **Nhật ký agent không phải transcript giao thức** — xem giải thích ở mục
  [Nhật ký hội thoại với agent](#nhật-ký-hội-thoại-với-agent).
- **Máy chạy bản cũ chỉ nói giao thức thô.** Kênh giữa các máy giờ mã hoá TLS-PSK;
  máy chưa nâng cấp phải đánh dấu `machines.js tls <máy> off` và khi đó kênh tới
  nó đọc được trên đường truyền. Vẫn nên ở trong LAN/VPN.
- **Nhận dạng giọng nói gửi âm thanh tới Apple/Google**, không xử lý cục bộ.
- **Split view** chia đôi ngang/dọc theo tỉ lệ cố định 50/50; chưa kéo thả được
  đường chia. Màn hình cao dưới 520px sẽ từ chối split.
- **Git API chỉ đọc.** Cố ý: commit/pull/push phải gõ trong terminal.
- Nền tảng chính là Windows (node-pty + ConPTY). Linux chạy được cả web server lẫn PTY host (bash/zsh/sh,
  toàn bộ test xanh); macOS chưa kiểm thử.
