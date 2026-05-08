# Hello CLI — wrap hello.py thành command-line tool có flag

[GOAL] Biến `project/backend/hello.py` thành CLI hoàn chỉnh: chạy được `python -m backend.hello --name Tom`, có `--help`, exit code chuẩn, có 1 vài test pytest pass.

[CONTEXT]
- Hiện trạng: `project/backend/hello.py` đã có hàm `greet(name)` + entrypoint `__main__` đơn giản dùng `sys.argv` (Usage: `hello.py <name>`). Chưa có argparse, chưa có test.
- Pain point: script thô, không có `--help`, không có flag, khó mở rộng (vd: `--upper`, `--lang`), chưa có test → không an toàn để nhiều agent cùng sửa sau này.

[SCOPE]
Phải có:
- Refactor `project/backend/hello.py` dùng `argparse`:
  - `--name <str>` (required) — tên cần chào.
  - `--upper` (flag) — in HOA toàn bộ output.
  - `--lang {en,vi}` (default `en`) — `en` → "Hello, X!", `vi` → "Chào X!".
- `--help` tự động sinh từ argparse, có description rõ.
- Exit code: `0` thành công, `2` khi thiếu arg (argparse default).
- Giữ hàm `greet(name, lang="en", upper=False) -> str` để test unit độc lập.
- Test `project/backend/tests/test_hello.py` (pytest), tối thiểu 4 case: en thường, vi thường, upper, missing arg → SystemExit.
- README ngắn ở `project/backend/README.md` mô tả cách chạy CLI.

Không làm:
- Không thêm dependency ngoài stdlib (argparse, pytest đã có sẵn nếu repo dùng).
- Không build package/`setup.py`/`pyproject.toml` mới — chạy bằng `python -m backend.hello` từ root `project/`.
- Không đụng frontend/electron.

[CONSTRAINTS]
- Python 3 stdlib only.
- File path bắt buộc: `project/backend/hello.py`, `project/backend/tests/test_hello.py`.
- Không phá API hàm `greet` cũ — chỉ mở rộng tham số có default, để code khác (nếu có) không vỡ.

[ACCEPTANCE]
- `cd project && python -m backend.hello --name Tom` → in `Hello, Tom!`.
- `cd project && python -m backend.hello --name Tom --upper` → in `HELLO, TOM!`.
- `cd project && python -m backend.hello --name Tom --lang vi` → in `Chào Tom!`.
- `cd project && python -m backend.hello --help` → hiện usage có 3 flag trên, exit 0.
- `cd project && python -m backend.hello` (thiếu `--name`) → exit code 2.
- `cd project && pytest backend/tests/test_hello.py -q` → 4/4 pass.

[DELIVERABLES]
- `project/backend/hello.py` (refactor).
- `project/backend/tests/test_hello.py` (mới).
- `project/backend/README.md` (mới, vài dòng).
- Demo command: `cd project && python -m backend.hello --name Tom --lang vi --upper`.

Open questions (nếu có):
- "hello cli" của bạn có ý đồ rộng hơn không (vd: interactive REPL, đọc tên từ stdin, đa ngôn ngữ thật sự i18n)? Mình đang giả định CLI tool 1-shot đơn giản như trên.
- Có cần script wrapper `bin/hello` để gọi `hello` trực tiếp không, hay chạy qua `python -m` là đủ?
- Có muốn ràng test pass vào CI/hook nào sẵn có không?

Hãy plan trước (tách sub-task, gán owner, deps), trình bày plan cho tôi confirm rồi mới ghi tasks.json và gửi inbox. Đừng fan-out luôn.
