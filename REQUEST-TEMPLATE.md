# Mẫu yêu cầu cho coordinator

Copy khối dưới, điền `<...>`, xoá dòng không cần, dán vào chat `orch-coordinator`.

```
Phía: <FE | BE | cả hai>
Làm gì: <1–3 câu>
Ở đâu (nếu biết): <màn hình / file / endpoint>
Xong khi: <điều kiện kiểm được, vd. "nút header cao 32px khi hover">
Giữ nguyên: <điều không được đổi>
Agent (nếu muốn khác mặc định): <FE dùng Codex | BE dùng Claude>

Lập plan, cho tôi xem tóm tắt rồi ghi request để tôi duyệt.
```

Mặc định: FE do Claude + Chrome làm (xem được giao diện, cần BE đang chạy), BE do Codex làm.

## Ví dụ

```
Phía: FE
Làm gì: Top nav, nền hover của nút thấp lại khoảng 32px thay vì cao bằng cả thanh.
Ở đâu: src/shared/components/header.jsx
Xong khi: nút header cao <= 32px khi hover, xem trên desktop và mobile.
Giữ nguyên: vị trí, icon, hành vi click.

Lập plan, cho tôi xem tóm tắt rồi ghi request để tôi duyệt.
```

```
Phía: BE
Làm gì: <màn hình> lỗi khi <thao tác>. Stack trace: <dán, xoá token nếu có>
Xong khi: có test tái hiện lỗi cũ và nay pass.

Lập plan, cho tôi xem tóm tắt rồi ghi request để tôi duyệt.
```

## Lưu ý

- Việc lớn, chưa rõ hướng: bàn với debby trước (Debby2OPENSPECS.md), dán kết quả vào "Làm gì".
- Không dán secret, token, `.env`.
- Duyệt một lần là chạy cả plan; coordinator tự báo tiến độ, xong hoặc dừng.
- FE: sau khi merge, bạn tự tick task OpenSpec.
