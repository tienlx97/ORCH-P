# SHIPDOC: các bước tiếp theo

Ghi ngày 2026-10-15. Có hai cách làm: chạy bằng **Terminal** hoặc qua **UI** (Omnigent, http://127.0.0.1:6767).

## Trạng thái hiện tại

| Task | Trạng thái |
|---|---|
| **SHIPDOC-01** (BE, domain) | Đã duyệt. `prepare` ✅, `implement` ✅ (Codex exit 0, worktree `~/orch-worktrees/SHIPDOC-01-be`). **Còn lại: `check` → `verify` → `commit` → review** |
| SHIPDOC-02 (BE, persistence/API) | `proposed`, `base_revision` vẫn là placeholder |
| SHIPDOC-03 (BE, sync/import) | `proposed`, `base_revision` vẫn là placeholder |
| SHIPDOC-04 (FE) | `proposed`, acceptance_criteria chưa viết (chờ SHIPDOC-02 merge) |

Bước tiếp theo là **chạy nốt SHIPDOC-01**. Chưa duyệt 02/03/04 (lý do ở mục 3).

---

## 1. SHIPDOC-01: check → verify → commit

Đừng sửa `runs/proposals/SHIPDOC-01.json` lúc này. Nếu file bị sửa sau `prepare`, digest sẽ đổi và các bước sau sẽ bị từ chối.

### Cách A: Terminal (chạy trực tiếp, không qua Omnigent)

```sh
cd ~/work/DEV-P/ORCH-P
T=runs/proposals/SHIPDOC-01.json

node orchestrate/orchestrate.mjs check  $T be   # diff nằm trong allowed_paths, quét secret
node orchestrate/orchestrate.mjs verify $T be   # chạy harness/verify.sh của BE-P trong container
node orchestrate/orchestrate.mjs commit $T be   # commit local có trailer Verified-Tree
node orchestrate/orchestrate.mjs status $T      # xem trạng thái
```

Nếu `verify` fail (exit khác 70), lỗi được ghi thành rework. Chạy lại vòng sau trên cùng worktree:

```sh
node orchestrate/orchestrate.mjs implement $T be
node orchestrate/orchestrate.mjs check $T be && node orchestrate/orchestrate.mjs verify $T be
```

Exit 70 là lỗi hạ tầng (Docker/container), không phải lỗi code. Gặp exit 70 thì sửa môi trường rồi chạy lại `verify`.

### Cách B: UI (Omnigent)

1. Terminal 1: `node orchestrate/cockpit.mjs host` (bỏ qua nếu host đang chạy).
2. Terminal 2: `node orchestrate/runner.mjs`. Để terminal này mở suốt quá trình.
3. Nếu chưa có session coordinator: `node orchestrate/cockpit.mjs start`.
4. Nhắn coordinator:

   > Task ORCH-P/runs/proposals/SHIPDOC-01.json đã prepare và implement xong (xem runs/requests/*.result.json). Chạy tiếp check, verify, commit cho bên be. Đọc kết quả từng bước trước khi gửi bước tiếp; báo tôi nếu có bước fail.

5. Mỗi bước hiện một hộp **ASK**, bạn bấm duyệt. Kết quả nằm ở `runs/requests/SHIPDOC-01-be-<step>.result.json`.

---

## 2. Review SHIPDOC-01

### Cách A: Terminal (Claude Code)

Mở Claude Code trong ORCH-P và nhắn:

> Review task runs/proposals/SHIPDOC-01.json: đối chiếu từng acceptance_criteria với test, ghi review.json rồi chạy review-record.

Lệnh `node orchestrate/orchestrate.mjs review-record <task> <review.json>` chỉ chạy được từ một process Claude Code, vì đây là provenance check.

### Cách B: UI

```sh
node orchestrate/cockpit.mjs start reviewer
```

Sau đó nhắn reviewer: *"Review task ORCH-P/runs/proposals/SHIPDOC-01.json."*

### Sau review

Chạy `node orchestrate/orchestrate.mjs status runs/proposals/SHIPDOC-01.json`:

- `ready_for_human_merge`: sang bước push/merge.
- `rework_required`: chạy lại `implement → check → verify → commit`, rồi review lại.

### Push / merge (bạn tự làm)

```sh
cd ../BE-P
git log agent/shipdoc-01-be -3          # xem commit đã verify
git push origin agent/shipdoc-01-be      # rồi tự mở PR và merge
cd ../ORCH-P
node orchestrate/orchestrate.mjs cleanup runs/proposals/SHIPDOC-01.json
```

---

## 3. Sau khi SHIPDOC-01 merge: duyệt các task còn lại

**SHIPDOC-02 và 03** cần code domain của 01, nên `base_revision.be` phải là SHA BE-P **sau khi 01 đã merge**, không phải `aec0d59`.

1. Lấy SHA: `git -C ../BE-P rev-parse <nhánh-đã-merge>` rồi điền vào task file.
2. Cả hai là `complexity: complex`, nên được phép (không bắt buộc) đưa qua **debby** trước khi duyệt. Trong UI: new session → agent `debby` → dán proposal → `/debate`. Đọc phần tổng hợp rồi tự sửa task file.
3. Duyệt trong terminal: sửa `"status": "approved"` và
   `"approval": { "source": "Duyệt trong Claude Code ngày <ngày>", "approved_by": "<bạn>" }`, rồi chạy:

   ```sh
   node orchestrate/orchestrate.mjs validate runs/proposals/SHIPDOC-02.json
   ```

4. Chạy tiếp như mục 1 và 2, bắt đầu từ `prepare`:
   - Terminal: `node orchestrate/orchestrate.mjs prepare runs/proposals/SHIPDOC-02.json`, rồi `implement`, `check`, `verify`, `commit` với tham số `be`.
   - UI: nhắn coordinator *"Task ORCH-P/runs/proposals/SHIPDOC-02.json đã được duyệt. Chạy lần lượt: prepare, rồi implement, check, verify, commit cho bên be. Đọc kết quả từng bước trước khi gửi bước tiếp; báo tôi nếu có bước fail."*

**Lưu ý SHIPDOC-02:** task có `contract_check: true` nhưng lệnh `contract` đang bị tắt. Vì vậy task này **không bao giờ tự lên được `ready_for_human_merge`**. Sau review, chạy thủ công `../BE-P/docs/coordination/pilot.md` rồi mới merge.

**SHIPDOC-02 có migration:** kiểm tra kỹ migration chỉ thêm cột/bảng, không sửa migration cũ, và dữ liệu cũ giữ nguyên type/path.

## Thứ tự

```text
SHIPDOC-01 → SHIPDOC-02 → SHIPDOC-03
                       └→ SHIPDOC-04 (FE, viết acceptance_criteria từ docs/api/ShipmentFiles.md sau khi 02 merge)
```

SHIPDOC-03 và SHIPDOC-04 có thể chạy song song sau khi SHIPDOC-02 merge.
