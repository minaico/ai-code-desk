/**
 * Static DOM for the application shell.
 *
 * Desktop gets a sidebar; a phone gets the stacked layout required by the
 * spec: tabs, session + cwd header, terminal, native input, favourite keys,
 * more keys. The markup is shared, the CSS decides what is shown.
 *
 * The markup is written in Vietnamese; translateDom swaps in English at mount
 * when that is the chosen language (see src/lib/i18n.js).
 */
import { translateDom, tr } from "../lib/i18n.js";

export const SHELL_HTML = `
<div id="menuBackdrop" class="hidden"></div>

<aside id="sidebar">
  <div id="sideHead">
    <h1>AI Code Desk</h1>
    <button id="btnProfile" class="hidden" title="Tài khoản đang đăng nhập">
      <span id="profileAvatar" class="avatar"></span>
      <span id="profileName" class="ellipsis"></span>
    </button>
  </div>
  <div id="profileMenu" class="hidden">
    <div id="profileWho"></div>
    <button id="profilePassword">Đổi mật khẩu</button>
    <button id="profileUsers" class="hidden">Quản lý người dùng</button>
    <button id="profileLogout" class="danger">Đăng xuất</button>
  </div>
  <div class="side-actions" id="sideLaunchers"></div>
  <div class="side-actions">
    <button id="btnFiles">📁 Files</button>
    <button id="btnGit">⑂ Git</button>
    <button id="btnHistory">🕘 History</button>
    <button id="btnWorkspace" title="Mở lại các tab của phiên trước">🗂 Phiên</button>
    <button id="btnHosts">🖧 Máy</button>
    <button id="btnDiag">🩺 Diagnostics</button>
    <button id="btnSettings">⚙ Settings</button>
    <button id="btnKeyConfig" class="keys-tool">⌨ Phím</button>
  </div>
  <h1>Sessions</h1>
  <div id="sessionList"></div>
</aside>

<div id="workspace">
  <header id="topbar">
    <button id="btnNew" title="New terminal">＋</button>
    <div id="tabs"></div>
    <div class="topbar-tools">
      <button data-action="mic" class="voice-tool desktop-tool" title="Nói">🎤</button>
      <button data-action="speak" class="voice-tool desktop-tool" title="Đọc kết quả">🔊</button>
      <button id="btnPalette" title="Command palette (Ctrl+K)">⌘</button>
      <button id="btnSplit" title="Split">▤</button>
      <button id="btnReader" title="Xem gọn output của Claude">📄</button>
      <button id="btnMoreKeys" class="keys-tool" title="Phím khác">⌨</button>
      <!-- On a phone the side panel has nowhere to live, so this opens it as a
           drawer. It is also where key configuration moved to. -->
      <button id="btnMenu" class="keys-tool" title="Menu">⚙</button>
      <button id="btnPanel" class="desktop-tool" title="Ẩn/hiện panel">▥</button>
    </div>
  </header>

  <!-- The assist bar floats over the terminal instead of sitting above it.
       A bar that took a row of its own changed the PTY size every time it
       appeared, the running TUI repainted, and the repaint changed what the
       next analysis read - a bar that hid and showed itself forever. -->
  <main id="panes">
    <div id="assist" class="hidden">
      <div id="assistTitle">Claude Assist<small id="assistHint"></small></div>
      <div id="assistActions"></div>
      <button id="assistOff" title="Tắt Claude Assist">✕</button>
    </div>
  </main>

  <section id="reader" class="hidden">
    <div id="readerHead">
      <span>Tóm tắt phiên Claude</span>
      <button id="readerOff" title="Về terminal">✕</button>
    </div>
    <div id="readerList"></div>
    <div id="readerEmpty" class="hidden"></div>
  </section>

  <section id="inputbar">
    <textarea id="cmdInput" rows="1" placeholder="Nhập lệnh... (Shift+Enter xuống dòng)" autocomplete="off"
      autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="send"></textarea>
    <button data-action="mic" class="voice-tool mobile-tool" title="Nói">🎤</button>
    <button data-action="speak" class="voice-tool mobile-tool" title="Đọc kết quả">🔊</button>
    <button id="cmdSend" title="Gửi">↵</button>
  </section>

  <section id="keybar">
    <div id="favKeys"></div>
    <div id="moreKeys" class="hidden"></div>
  </section>
</div>

<dialog id="loginDlg">
  <form method="dialog" id="loginForm">
    <div class="dlg-head">AI Code Desk</div>
    <div class="dlg-body">
      <p class="muted" id="loginHint">Đăng nhập để tiếp tục.</p>
      <label class="field" id="loginUserField"><span>Tên đăng nhập</span>
        <input id="loginUsername" autocomplete="username" spellcheck="false" autocapitalize="off"></label>
      <label class="field"><span>Mật khẩu</span>
        <input id="loginPassword" type="password" autocomplete="current-password"></label>
      <p id="loginError" class="hidden" style="color:#fca5a5"></p>
    </div>
    <div class="dlg-foot"><button class="primary" id="loginSubmit">Đăng nhập</button></div>
  </form>
</dialog>

<dialog id="newDlg">
  <form method="dialog" id="newForm">
    <div class="dlg-head">Terminal mới<button type="button" data-close>✕</button></div>
    <div class="dlg-body">
      <label class="field"><span>Máy</span><select id="newHost"></select></label>
      <label class="field"><span>Shell</span><select id="newShell"></select></label>
      <p id="newShellNote" class="muted hidden" style="font-size:11.5px;margin:-4px 0 0"></p>
      <label class="field"><span>Thư mục làm việc</span>
        <span class="row">
          <input id="newCwd" class="grow" placeholder="Mặc định" spellcheck="false" autocapitalize="off">
          <button type="button" id="newBrowse" title="Chọn thư mục">📁</button>
        </span>
      </label>
      <label class="field"><span>Tên tab</span><input id="newTitle" placeholder="PowerShell"></label>
      <label class="field"><span>Lệnh chạy ngay (tuỳ chọn)</span>
        <input id="newAutoRun" placeholder="ví dụ: claude"></label>
    </div>
    <div class="dlg-foot">
      <button type="button" data-close>Huỷ</button>
      <button class="primary" id="newSubmit">Tạo</button>
    </div>
  </form>
</dialog>

<dialog id="fileDlg">
  <div class="dlg-head">File Explorer<button type="button" data-close>✕</button></div>
  <div id="filePath"></div>
  <div class="dlg-body">
    <div class="row" style="margin-bottom:10px">
      <button id="fileUp">⬆ Lên</button>
      <select id="fileRoots" class="grow"></select>
      <button id="fileNewDir">＋ Thư mục</button>
      <button id="fileRefresh">⟳</button>
    </div>
    <div id="fileList"></div>
  </div>
  <div class="dlg-foot" style="justify-content:space-between">
    <div class="row grow">
      <input type="file" id="fileUpload" class="grow">
      <button id="fileUploadBtn">Upload</button>
    </div>
  </div>
  <div id="uploadBar" class="hidden"><div></div></div>
</dialog>

<dialog id="dirDlg">
  <div class="dlg-head">Chọn thư mục<button type="button" data-close>✕</button></div>
  <div id="dirPath"></div>
  <div class="dlg-body">
    <div class="row" style="margin-bottom:10px">
      <button id="dirUp" type="button">⬆ Lên</button>
      <button id="dirDrives" type="button" title="Danh sách ổ đĩa">💾</button>
      <input id="dirManual" class="grow" placeholder="Hoặc gõ đường dẫn..." spellcheck="false" autocapitalize="off">
      <button id="dirGo" type="button">→</button>
    </div>
    <div id="dirShortcuts" class="row" style="flex-wrap:wrap;margin-bottom:10px"></div>
    <div id="dirList"></div>
  </div>
  <div class="dlg-foot">
    <button type="button" data-close>Huỷ</button>
    <button class="primary" id="dirPick" type="button">Chọn thư mục này</button>
  </div>
</dialog>

<dialog id="tabDlg">
  <div class="dlg-head">Tab<button type="button" data-close>✕</button></div>
  <div class="dlg-body">
    <label class="field"><span>Tên tab</span>
      <input id="tabName" placeholder="Để trống = theo tên thư mục" spellcheck="false"></label>
    <label class="choice"><input type="checkbox" id="tabAuto">
      <span>Tự đổi tên theo thư mục đang đứng</span></label>
    <p class="muted" id="tabAutoHint"></p>
    <p id="tabMsg" class="dlg-msg hidden"></p>
    <p class="muted" style="margin:14px 0 6px">Màu tab</p>
    <div id="tabColors" class="color-grid"></div>
    <div class="row" style="margin-top:18px;flex-wrap:wrap">
      <button id="tabRestart" type="button">↻ Restart</button>
      <button id="tabKill" type="button" class="danger">■ Kill</button>
      <button id="tabCloseTab" type="button" class="danger">🗑 Đóng tab</button>
    </div>
  </div>
  <div class="dlg-foot">
    <button type="button" data-close>Huỷ</button>
    <button class="primary" id="tabSave" type="button">Lưu</button>
  </div>
</dialog>

<dialog id="historyDlg">
  <div class="dlg-head">Lịch sử session<button type="button" data-close>✕</button></div>
  <div class="dlg-body">
    <div class="row" style="margin-bottom:10px">
      <input id="historySearch" class="grow" placeholder="Tìm theo tên hoặc thư mục..." spellcheck="false">
      <button id="historyRefresh" type="button">⟳</button>
    </div>
    <p class="muted" style="margin-top:0">Bấm một dòng để mở lại đúng shell và đúng thư mục lúc đóng.</p>
    <div id="historyList"></div>
  </div>
</dialog>

<dialog id="hostsDlg">
  <div class="dlg-head">Các máy<button type="button" data-close>✕</button></div>
  <div class="dlg-body">
    <div id="hostsList"></div>
    <p class="muted">
      Mọi máy ngang hàng nhau; <b>máy chính</b> chỉ là máy đang chạy trang web này.
      Muốn máy khác làm máy chính: <code>node scripts/machines.js export</code> ở đây,
      <code>import</code> ở máy kia rồi chạy <code>scripts/resume.ps1</code> bên đó.
    </p>
    <h4 style="margin:16px 0 8px">Thêm máy</h4>
    <p class="muted" style="margin-top:0">
      Trên máy kia chạy <code>node scripts/host-key.js</code> để lấy key, và đặt
      <code>PTY_HOST_BIND=0.0.0.0</code> cho PTY host. Kết nối có xác thực nhưng
      <b>không mã hoá</b> — chỉ dùng trong LAN hoặc VPN.
    </p>
    <label class="field"><span>Tên</span><input id="hostName" placeholder="Máy văn phòng"></label>
    <label class="field"><span>Địa chỉ</span><input id="hostAddress" placeholder="192.168.1.50" spellcheck="false"></label>
    <label class="field"><span>Cổng</span><input id="hostPort" placeholder="8777" inputmode="numeric"></label>
    <label class="field"><span>Key của máy đó</span><input id="hostKey" placeholder="dán key ở đây" spellcheck="false"></label>
    <div class="row">
      <button id="hostProbe" type="button">Kiểm tra kết nối</button>
      <button id="hostAdd" type="button" class="primary">Thêm máy</button>
    </div>
    <p id="hostMsg" class="muted"></p>
  </div>
</dialog>

<dialog id="gitDlg">
  <div class="dlg-head">Git<button type="button" data-close>✕</button></div>
  <div class="dlg-body" id="gitBody"></div>
</dialog>

<dialog id="keyCfgDlg">
  <form method="dialog" id="keyCfgForm">
    <div class="dlg-head">Phím ưa thích (tối đa 8)<button type="button" data-close>✕</button></div>
    <div class="dlg-body"><div class="choice-grid" id="keyChoices"></div></div>
    <div class="dlg-foot">
      <button type="button" data-close>Huỷ</button>
      <button class="primary" id="keyCfgSave">Lưu</button>
    </div>
  </form>
</dialog>

<dialog id="diagDlg">
  <div class="dlg-head">Diagnostics<button type="button" data-close>✕</button></div>
  <div class="dlg-body" id="diagBody">Đang tải…</div>
  <div class="dlg-foot"><button id="diagRefresh">Làm mới</button></div>
</dialog>

<dialog id="settingsDlg">
  <div class="dlg-head">Settings<button type="button" data-close>✕</button></div>
  <div class="dlg-body" id="settingsBody"></div>
  <div class="dlg-foot"><button id="btnLogout" class="danger">Đăng xuất</button></div>
</dialog>

<dialog id="restoreDlg">
  <div class="dlg-head">Phiên làm việc trước<button type="button" data-close>✕</button></div>
  <div class="dlg-body">
    <p class="muted" id="restoreHint"></p>
    <div id="restoreList"></div>
  </div>
  <div class="dlg-foot">
    <button type="button" data-close>Để sau</button>
    <button type="button" id="restoreForget">Quên phiên này</button>
    <button class="primary" id="restoreRun">Khôi phục</button>
  </div>
</dialog>

<dialog id="passwordDlg">
  <form method="dialog" id="passwordForm">
    <div class="dlg-head" id="passwordHead">Đổi mật khẩu<button type="button" data-close id="passwordClose">✕</button></div>
    <div class="dlg-body">
      <p class="muted" id="passwordHint"></p>
      <label class="field"><span>Mật khẩu hiện tại</span>
        <input id="pwCurrent" type="password" autocomplete="current-password"></label>
      <label class="field"><span>Mật khẩu mới</span>
        <input id="pwNext" type="password" autocomplete="new-password"></label>
      <label class="field"><span>Nhập lại mật khẩu mới</span>
        <input id="pwConfirm" type="password" autocomplete="new-password"></label>
      <p id="pwError" class="hidden" style="color:#fca5a5"></p>
    </div>
    <div class="dlg-foot"><button class="primary" id="pwSubmit">Đổi mật khẩu</button></div>
  </form>
</dialog>

<dialog id="usersDlg">
  <div class="dlg-head">Người dùng<button type="button" data-close>✕</button></div>
  <div class="dlg-body">
    <div id="usersList"></div>
    <form id="userAddForm" class="user-add">
      <label class="field"><span>Tên đăng nhập mới</span>
        <input id="newUserName" placeholder="vd: an.nv" spellcheck="false" autocapitalize="off"></label>
      <label class="field"><span>Mật khẩu tạm (người đó sẽ phải đổi)</span>
        <input id="newUserPassword" type="text" spellcheck="false" autocapitalize="off"></label>
      <label class="choice"><input id="newUserAdmin" type="checkbox"><span>Quản trị viên</span></label>
      <button class="primary" id="userAddSubmit">Thêm người dùng</button>
    </form>
    <p id="usersError" class="hidden" style="color:#fca5a5"></p>
  </div>
</dialog>

<dialog id="paletteDlg">
  <input id="paletteInput" placeholder="Lệnh hoặc tên session..." autocomplete="off" spellcheck="false">
  <div id="paletteList"></div>
</dialog>
`;

export function mountShell(root) {
  root.innerHTML = SHELL_HTML;
  translateDom(root);
  const el = (id) => root.querySelector(`#${id}`);
  // Every dialog gets a working close button.
  root.querySelectorAll("dialog").forEach((dlg) => {
    dlg.querySelectorAll("[data-close]").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.preventDefault();
        dlg.close();
      });
    });
  });
  return el;
}

let toastTimer = null;
export function toast(message, bad = false) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const node = document.createElement("div");
  node.className = `toast${bad ? " bad" : ""}`;
  // Server errors and browser messages arrive in whatever language they were
  // written in; this is the one place every message passes through.
  node.textContent = tr(message);
  // A modal dialog lives in the top layer, which no z-index can beat, so a
  // toast appended to <body> while one is open is simply invisible - which
  // makes a failing button look like a button that does nothing.
  (document.querySelector("dialog[open]") || document.body).appendChild(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), bad ? 5200 : 2600);
}

export function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
