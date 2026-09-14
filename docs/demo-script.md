# Demo script · Kịch bản demo

How the screenshots and the GIF in the READMEs were made, so they can be made again after the UI changes —
with real sessions, never staged ones.
Ảnh và GIF trong README được làm thế nào, để làm lại được khi giao diện đổi — luôn bằng phiên thật, không dựng cảnh.

## The story · Câu chuyện

One person, one working day: about 25 projects open as tabs, agents running on two machines, and the questions
they actually ask the tool — *where is everything, can I see two at once, can I start one over there, what happens
after a power cut, can I do this from my phone, can I show it to someone.* Each scene answers one of them.

Một người, một ngày làm việc: khoảng 25 dự án mở thành tab, agent chạy trên hai máy, và những câu họ thật sự hỏi
công cụ — *mọi thứ ở đâu, xem hai cái cùng lúc được không, mở một cái ở máy kia được không, mất điện thì sao, làm
từ điện thoại được không, cho người khác xem được không.* Mỗi cảnh trả lời một câu.

| # | File | Question · Câu hỏi | On screen · Trên màn hình | How to get there · Cách dựng |
|---|---|---|---|---|
| 1 | `01-overview.jpg` | Where is everything? · Mọi thứ ở đâu? | All tabs; circle = this machine, triangle = the other; green = an agent worked here; launchers for every installed agent; the active tab's typed line readable | Select a Claude tab whose last typed line is visible |
| 2 | `02-two-machines.jpg` | Two at once? · Hai cái cùng lúc? | Vertical split: an agent on this machine left, one on the other machine right | Select a tab on the other machine, press ▤ twice (horizontal → vertical) |
| 3 | `03-new-terminal.png` | Start one over there? · Mở ở máy kia? | *New terminal*: machine = the other one, tab name `Codex`, run on start `codex` | ＋, pick the machine, fill the two fields, **do not press Create** |
| 4 | `04-machines.png` | What machines? · Những máy nào? | Machine list: names, shapes, main machine, add form | Machines panel; blur the host name of the main machine (it holds a person's name) |
| 5 | `05-workspace.png` | After a power cut? · Mất điện thì sao? | "25 tabs saved … 25 running" and the list | Workspace button |
| 6 | `06-phone.jpg` | From the phone? · Từ điện thoại? | Phone layout, typed line readable, a sample message in the command box, key bar | Window at phone width, put a sample sentence in the box, **do not send** |
| 7 | `07-phone-menu.jpg` | Start an agent from the phone? · Mở agent từ điện thoại? | The ⚙ drawer with every agent button | ⚙ on the phone layout |
| 8 | `08-settings.png` | Show it to someone? · Cho người khác xem? | Interface language, *Blur output and paths*, virtual rows, voice | Settings |

Every scene is shot twice, once per interface language, into `docs/images/en/` and `docs/images/vi/`.
Mỗi cảnh chụp hai lần, mỗi ngôn ngữ giao diện một lần.

## Setup · Chuẩn bị

1. **A window that cannot disturb anyone.** Open the UI as `/?view&blur`:
   - `?view` attaches without claiming a size, so a window of another size does not make every agent redraw;
   - `?blur` turns on presenting mode for this window only: output rows, paths and the account name are blurred,
     typed lines are not.
2. **The language.** Settings → *Interface language*, or `localStorage.setItem("wt.lang", "en" | "vi")` and reload.
   Remove the key afterwards so the browser's own language applies again.
3. **Sizes.** Desktop: a window whose page is 1920×863 CSS px (the screenshots come out 1568×705). Phone: the
   narrowest Chrome window, 508 px wide — anything under 820 px gets the phone layout. Pages cannot be framed
   (`X-Frame-Options: DENY`), so a narrow window is the only way to shoot the phone layout from a desktop.
4. **The mouse** goes to a corner before every shot.
5. **Dialogs** are captured as their own region, not as the whole screen, so their text stays legible.

## The GIF · GIF

`docs/images/demo.gif`, English UI, about 30 frames, each captured on an action:

1. The overview, with an agent tab on this machine in front.
2. Scroll the tab strip, click a tab on the other machine (▲).
3. ▤ twice: the two machines side by side.
4. Machines: the list of peers, then close it.
5. ＋: choose the other machine, type `Codex` as the name and `codex` as the command.
6. Cancel. Nothing is created.

Before recording, add a CSS rule that blurs the main machine's row name, so the frame captured right after the
panel opens is already covered. After exporting, look at every frame (a contact sheet makes that quick) and drop
stray ones — a zoom taken during recording becomes a small frame on a white background. Then shrink it:

```bash
ffmpeg -i raw.gif -vf "select='not(eq(n\,15))',scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 docs/images/demo.gif
ffmpeg -i docs/images/demo.gif -vf "scale=400:-1,tile=4x8:padding=4" -frames:v 1 sheet.png   # contact sheet
```

## Before publishing · Trước khi đăng

Presenting mode blurs what programs print. It does **not** blur what was typed — that is the point — so read
every typed line that is visible:

- scene 1 and the phone shots show one typed line of a real session;
- scene 2 shows a typed line with an attached file name that names a project;
- machine names ("Máy 42", "43 (Linux)") are shown on purpose; the main machine's host name is blurred by hand.

If a typed line should not be public, pick another tab for that scene, or reshoot after that session has moved on.

Chế độ trình chiếu làm mờ những gì chương trình in ra, **không** làm mờ những gì bạn gõ — vì đó là mục đích — nên
hãy đọc lại mọi dòng gõ còn nhìn thấy trước khi đăng. Dòng nào không nên công khai thì chọn tab khác cho cảnh đó.
