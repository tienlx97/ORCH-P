# Test: diễn biến Codex trong chat coordinator (A) và Codex là session con (B)

Ngày: 2026-10-16. Không test nào sửa code BE-P / FE-P.

## Test B1 — session con có hiện trong chat coordinator không

**Kiểm tra gì:** Omnigent có hiển thị session Codex tạo với `parent_session_id` bên trong
(hoặc ngay dưới) session coordinator hay không. Sandbox của session con
(`runs/orch-step0-child/omnigent-report.json`) giống hệt session độc lập: NOT READY, chạy được
nhờ accepted risk `codex-read-isolation` (CANARY/SSH key/Codex auth/Omnigent state/BE `.env`
đọc được); ghi ngoài worktree, mạng, loopback và biến credential bị chặn.

Lần chạy 2026-10-16 (sau khi khởi động lại): coordinator `2f5744d508774a48bf27e92ecb9b8fad`
("Shipment alerts stack trace error"), session con `615aef53fecb42ee94c901ab230e54e9`.
- [x] Kết quả session con về chat coordinator dưới dạng thông báo "sub-agent task … completed".
- [x] Coordinator không thấy nó trong danh sách sub-agent của mình.
- [x] Trong UI: chỉ thấy thông báo, không mở được session con từ chat (người dùng xác nhận).

**Kết luận B1: không đạt → giữ A.** `implement` không tạo Codex làm session con.

Các bước:
1. Mở http://127.0.0.1:6767 (F5), mở session coordinator đang dùng.
2. Tìm session **"ORCH-P Step 0 (Omnigent)"**: trong khung chat (thông báo sub-agent — bấm vào
   được không?), mục sub-agent, hoặc thụt vào dưới coordinator ở danh sách bên trái.
3. Mở nó: phải thấy Codex chạy `node orch-check.mjs` và kết quả các check.

Muốn xem lúc đang chạy, tạo thêm một session con (1–2 phút, một lượt Codex nhỏ):

```sh
cd ORCH-P && ORCH_STEP0_DIR=runs/orch-step0-child \
  ORCH_PROBE_PARENT_SESSION=<id session coordinator đang dùng> node orchestrate/step0-omnigent.mjs
```

| Kết quả | Việc tiếp |
|---|---|
| Thấy session con trong / dưới coordinator, mở được | Chuyển sang B: `implement` tạo Codex làm con của coordinator |
| Không thấy (chỉ nằm riêng trong danh sách) | Giữ A |

## Test A1 — `wait` chạy được

**Kiểm tra gì:** lệnh in trạng thái plan và thoát đúng mã (0 xong, 1 dừng).

```sh
node ORCH-P/orchestrate/autopilot.mjs wait ORCH-P/runs/proposals/SHIPDOC-R7.plan.json; echo "exit $?"
```

Mong đợi (sau tối đa 2 phút, vì plan đã xong từ trước):
`plan SHIPDOC-R7: done`, `SHIPDOC-04B3: ready_for_human_merge`, `exit 0`.

## Test A2 — coordinator tự theo dõi plan và đăng diễn biến Codex

**Kiểm tra gì:** sau một lần duyệt, coordinator không hỏi "tiếp", tự đăng tiến độ và tin của
Codex vào chat, tự báo khi xong / dừng.

Các bước:
1. Thoát coordinator đang mở, chạy `node orchestrate/cockpit.mjs start` (nạp prompt mới).
2. Đưa task / plan kế tiếp, duyệt **một lần** request `autopilot`.
3. Không nhắn gì, chỉ quan sát.

Mong đợi:
- [ ] Đăng ngay khi task chuyển bước (implement → check → verify → commit → review).
- [ ] Khi Codex đang code, ~3 phút một lần: `Codex session: …`, `Codex ran N commands; last: …`,
      `Codex: <tin mới nhất>`.
- [ ] Khi plan xong: danh sách nhánh để merge theo thứ tự. Khi dừng: lý do và cần làm gì.
- [ ] Không có câu "nhắn tiếp", "quay lại sau".

Sai thì gửi lại đoạn chat của coordinator.

## Đã thay đổi (chưa commit)

- `orchestrate/autopilot.mjs`: `wait`, `progressOf`, đọc session Codex tăng dần.
- `orchestrate/orchestrate.mjs`: ghi `live/agents/<side>.session.json` khi Codex bắt đầu.
- `orchestrate/lib/omnigent-runner.mjs`: `items(id, { after })`, `onSession`, `parentSessionId`.
- `orchestrate/step0-omnigent.mjs`: `ORCH_PROBE_PARENT_SESSION` (thử B).
- `omnigent/orch-coordinator/config.yaml`: bước 5 tự theo dõi bằng `wait`.
- `AGENTS.md`: quy tắc 7 nới (2026-10-15).
