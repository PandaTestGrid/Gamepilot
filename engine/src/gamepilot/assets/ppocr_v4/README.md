# PP-OCRv4 Mobile ONNX（离线 OCR）

引擎内置三份 ONNX，随 `gamepilot` 包分发，**无需联网下载**：

- `ch_PP-OCRv4_det_infer.onnx` — 文本检测
- `ch_ppocr_mobile_v2.0_cls_infer.onnx` — 方向分类
- `ch_PP-OCRv4_rec_infer.onnx` — 识别

也可通过环境变量 `GAMEPILOT_OCR_MODEL_DIR` 指向自定义目录。
