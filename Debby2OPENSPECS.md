## Spec của debby
<<< DÁN NGUYÊN VĂN SPEC / PHẦN TỔNG HỢP CỦA DEBBY VÀO ĐÂY >>>


## Việc cần làm
Đọc code hiện có rồi chia công việc theo quy trình ORCH-P:

1. Đối chiếu spec với code hiện tại: phần nào đã có, phần nào mới, phần nào
   mâu thuẫn. Nếu spec có chỗ mơ hồ hoặc mâu thuẫn, hỏi tôi trước khi viết.
2. Chia thành các task ORCH-P: BE trước, FE sau (mỗi task một bên). Nếu BE
   quá lớn cho một lần implement (~60 phút), tách thành nhiều task nối tiếp
   và giải thích lý do tách.
3. Mỗi task cần:
   - OpenSpec change: openspec/changes/<slug>/proposal.md và tasks.md trong
     đúng repo, theo quy ước OpenSpec hiện có của repo đó
   - Bản nháp task file ORCH-P/runs/proposals/<ID>.json với "status":
     "proposed", "approval": null, base_revision là SHA đầy đủ hiện tại,
     complexity, model lấy từ `codex debug models`, allowed_paths hẹp nhất
     có thể, acceptance_criteria kiểm chứng được bằng test
   - Ghi rõ có cần contract_check không và vì sao
4. Tóm tắt cho tôi: danh sách task, thứ tự, phụ thuộc, rủi ro (đặc biệt là
   migration file cũ trên ổ mạng), và các câu hỏi còn mở.

## Giới hạn
- Không viết code tính năng; Codex sẽ làm qua ORCH-P.
- Không đánh dấu task là approved; tôi tự duyệt.
- Commit OpenSpec vào BE-P / FE-P chỉ sau khi tôi đồng ý nội dung; không push.

<!--  -->

Gần như không cần. Mình sẽ viết sẵn task file, nên phần việc của coordinator ngắn lại. Còn runner thì không cần nhập gì.

Runner: không cần ghi gì

node orchestrate/runner.mjs
Lệnh này không nhận tham số nào. Runner chỉ chờ các yêu cầu mà bạn bấm duyệt trên UI rồi chạy chúng. Cứ để terminal đó mở suốt quá trình.

Coordinator: chỉ cần một câu cho mỗi task

Bình thường coordinator soạn task file cho bạn. Lần này mình viết sẵn vào ORCH-P/runs/proposals/SHIPDOC-0X.json, nên bỏ qua bước soạn. Quy trình cho mỗi task:

1. Bạn duyệt task (terminal):
- Mở runs/proposals/SHIPDOC-01.json và đọc acceptance_criteria.
- Sửa "status": "approved" và
  "approval": { "source": "Duyệt trong Claude Code ngày 2026-10-15", "approved_by": "user" }
- Chạy:
node orchestrate/orchestrate.mjs validate runs/proposals/SHIPDOC-01.json

2. Nhắn coordinator (Web UI):

▎ Task ORCH-P/runs/proposals/SHIPDOC-01.json đã được duyệt. Chạy lần lượt: prepare, rồi implement, check, verify, commit cho bên be. Đọc kết quả từng bước trước khi gửi bước tiếp; báo tôi nếu có bước fail.

Coordinator tự lấy task_sha256 bằng validate, rồi gửi từng yêu cầu. Bạn chỉ việc bấm duyệt các hộp ASK khi chúng hiện ra.

3. Sau khi commit xong:
node orchestrate/cockpit.mjs start reviewer
Rồi nhắn reviewer: "Review task ORCH-P/runs/proposals/SHIPDOC-01.json."