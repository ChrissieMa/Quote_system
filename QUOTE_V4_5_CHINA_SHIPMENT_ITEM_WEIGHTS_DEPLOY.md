# Quote System v4.5 — China Shipment Item Weights

## 今次修正

- `/admin/costs` 新增「建立中國運費批次」。
- 可以跨月份勾選同一批 Order Items，例如 JUN2602、JUN2603、JUL2601–JUL2604。
- 每個 Order Item 分開輸入小糖提供的實際重量 KG。
- 輸入整批 `SF Freight RMB` 後，自動建立一筆 `China Shipments` record 並連結全部已選 Items。
- Airtable 繼續按以下正式公式分攤：

  `Item 重量 ÷ 全批 Item 總重量 × 整批 SF Freight RMB`

- `China Freight Cost HKD` 繼續用 `RMB ÷ 0.85`。
- `SF Actual Weight KG` 及 `SF Chargeable Weight KG` 只作記錄，不參與分攤。
- 防止同一個 Item 重複連接第二個 China Shipment。
- 建立後會同步受影響月份的 Monthly Finance / Dashboard。

## Airtable 欄位

正式 Airtable 已新增：

- `Order Items → China Freight Weight Input KG`

`Order Items → China Freight Weight KG` 已改為：

- 優先使用 `China Freight Weight Input KG`；
- 舊資料沒有直接輸入重量時，才 fallback 至原有 Delivery lookup `Weight KG`。

因此之前已完成的 China Shipment 分攤不會被清空。

## 部署

1. 將本更新包內容完整覆蓋 Quote System GitHub repo。
2. Commit / Push。
3. 等 Railway 自動重新部署。
4. 開啟 `/admin/costs?month=2026-07`。
5. 在「建立中國運費批次」勾選 Items、輸入每件 KG 及整批運費。

不需要修改現有 Railway Variables。`AIRTABLE_TABLE_CHINA_SHIPMENTS` 可不設定，系統預設使用 `China Shipments`。

## 今批待輸入

- JUN2602
- JUN2603
- JUL2601
- JUL2602
- JUL2603
- JUL2604
- 整批 SF Freight RMB：556

仍須取得以上每個 Order Item 的小糖實際重量，全部重量填齊後才可建立批次。
