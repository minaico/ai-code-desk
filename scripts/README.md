# Cloudflare public test script

Script này dùng Cloudflare Quick Tunnel để expose Web Terminal đang chạy ở
`http://127.0.0.1:9777` ra Internet bằng URL ngẫu nhiên `*.trycloudflare.com`.

## Cách dùng

Mở PowerShell:

```powershell
cd C:\ai-code-desk
.\start-public-test.ps1
```

Nếu Web Terminal chưa chạy, script sẽ tự chạy:

```text
npm start
```

Sau đó chạy:

```text
cloudflared tunnel --url http://127.0.0.1:9777
```

Cloudflare sẽ in ra URL kiểu:

```text
https://some-random-name.trycloudflare.com
```

Mở URL đó trên iPhone/PC ở ngoài LAN.

## Nếu cloudflared đã nằm trong PATH

Chỉ cần:

```powershell
cloudflared --version
```

là được.

Script cũng thử tìm `cloudflared.exe` ở một số thư mục Windows phổ biến.

## Password

Vì Web Terminal có khả năng chạy lệnh Windows, KHÔNG nên public Internet
nếu không có authentication.

Ví dụ trước khi chạy:

```powershell
$env:WEB_TERMINAL_PASSWORD="MatKhauRatManh"
.\start-public-test.ps1
```

Nếu V8 của bạn dùng cơ chế password khác, hãy giữ cấu hình hiện tại của V8.

Để bỏ cảnh báo password trong script chỉ dùng khi test nội bộ:

```powershell
.\start-public-test.ps1 -NoPassword
```

## Cloudflare config

Cloudflare Quick Tunnel có thể không hoạt động nếu có
`%USERPROFILE%\.cloudflared\config.yml` hoặc `config.yaml`.

Script chỉ cảnh báo, không tự đổi tên file.

Nếu cloudflared báo lỗi liên quan config, đổi tên tạm thời:

```powershell
Rename-Item "$env:USERPROFILE\.cloudflared\config.yml" "config.yml.bak"
```

rồi chạy lại script.

Sau khi test:

```powershell
Rename-Item "$env:USERPROFILE\.cloudflared\config.yml.bak" "config.yml"
```

## Dừng

Nhấn:

```text
Ctrl+C
```

để dừng Cloudflare Quick Tunnel.

Nếu script tự khởi động Web Terminal, cửa sổ PowerShell Web Terminal sẽ vẫn có thể
đang chạy; đóng cửa sổ đó hoặc dừng process Node khi test xong.

## Lưu ý

Quick Tunnel là URL tạm thời, phù hợp cho development/test, không phải production.
Cloudflare tạo URL ngẫu nhiên và URL thay đổi khi tunnel process được khởi động lại.

WebSocket của Web Terminal dùng cùng hostname/HTTP origin nên client có thể kết nối
`/terminal` qua WSS khi truy cập bằng HTTPS.
