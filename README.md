# gold-lunar-config

Dữ liệu tĩnh cho app **Vàng & Lịch**. App đọc trực tiếp qua raw URL, không có server nào ở giữa.

| File | Vai trò |
|---|---|
| `config/v1.json` | URL từng nguồn giá, cờ bật/tắt, và `notice` để hiện thông báo trong app |
| `forecast/v1.json` | Nhận định do mô hình ngôn ngữ viết, sinh tự động mỗi ngày |

## Chạy thử trên máy trước

```bash
cp .env.example .env      # rồi điền key vào .env
node --env-file=.env scripts/forecast.mjs
```

Kết quả ghi ra `forecast/v1.json` và in ra màn hình. Muốn xem phần tính toán mà không cần key:

```bash
DRY_RUN=1 node scripts/forecast.mjs
```

`.env` đã được gitignore. Không bao giờ commit file này: repo là public, key lộ ra là người khác đốt hết hạn mức của bạn.

## Cài đặt một lần

1. Tạo repo public tên `gold-lunar-config`, đẩy toàn bộ thư mục này lên nhánh `main`.
2. Lấy API key miễn phí:
   - Gemini: https://aistudio.google.com/apikey
   - Groq (tuỳ chọn, làm dự phòng): https://console.groq.com/keys
3. Vào **Settings > Secrets and variables > Actions**, thêm `GEMINI_API_KEY` và `GROQ_API_KEY`.
4. Vào tab **Actions**, chạy thử workflow bằng nút **Run workflow**.

Sau đó workflow tự chạy lúc 18:10 giờ Việt Nam mỗi ngày.

Script thử lần lượt nhiều tên model (`gemini-flash-latest` trước, rồi các bản cụ thể) vì nhà cung cấp hay ngừng phiên bản cũ. Gemini lỗi thì tự chuyển sang Groq. Mỗi ngày đúng một lần gọi mô hình nên không bao giờ chạm hạn mức miễn phí.

## App xử lý thế nào

App **luôn tự tính** xu hướng và độ tin cậy bằng thống kê chạy trên máy. Lời của mô hình chỉ được dùng khi:

- `date` đúng ngày hôm nay theo giờ Việt Nam, và
- `trend` trùng với kết luận app tự tính.

Không thoả một trong hai thì app dùng mẫu câu viết sẵn. Nhờ vậy con số và lời văn không bao giờ mâu thuẫn, và Action hỏng cũng không làm app hỏng.

Muốn tắt hẳn phần AI: sửa `config/v1.json`, đặt `sources.aiForecast.enabled = false`.
