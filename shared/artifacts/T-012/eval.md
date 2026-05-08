# T-012 — AI Prompts Delivery

## Files

| File | Purpose |
|------|---------|
| `/Users/tom/Downloads/test-web-seller/ai/prompts/product_description.py` | `PROMPT_TEMPLATE` + `render()` for product descriptions |
| `/Users/tom/Downloads/test-web-seller/ai/prompts/customer_chat.py` | `SYSTEM_PROMPT` for Vietnamese product-advisor chatbot |

## render() example output

Input: `render("Áo polo", 250000, "áo")`

```
Bạn là copywriter thương mại điện tử cho thị trường Việt Nam. Hãy viết mô tả sản phẩm ngắn gọn (2–3 câu) bằng tiếng Việt, tone tự nhiên, hấp dẫn, nêu bật lợi ích nổi bật và phù hợp với người mua hàng online.

Thông tin sản phẩm:
- Tên: Áo polo
- Giá: 250.000 VND
- Danh mục: áo

Chỉ trả về đoạn mô tả, không thêm nhãn hay giải thích.
```

## Brace-injection test

Input: `render("Áo {special}", 150000, "{cat}")` → renders safely (no crash, braces preserved in output).

## Verification

```
python3 -c "from ai.prompts.product_description import render; print(render('Áo polo', 250000, 'áo'))"
```
Run from `/Users/tom/Downloads/test-web-seller/` — exits 0.
