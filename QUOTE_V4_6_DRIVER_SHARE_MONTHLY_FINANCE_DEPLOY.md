# Quote System v4.6 — Driver Share and Monthly Finance

## 正式香港司機費規則

- 生效起點：`JUN2602`。
- Quote 內每個 Item 的香港運費繼續由 Chrissie 人手預大及輸入。
- 公司保留報價香港運費的 10%。
- 實際司機費為報價香港運費的 90%。
- 不再用「首 5kg HK$100、續重每 kg HK$10」重新推算 JUN2602 之後的司機費。
- `JUN2601` 或更早訂單繼續沿用原有 Delivery 實際司機成本。

## 特殊送貨安排

`Order_2026` 新增：

- `Driver Payable Override HKD`
- `Driver Payable HKD`

平時不用填 Override；系統會自動用報價香港運費 × 90%。只有直寄大陸、免香港司機或其他特殊安排才填指定金額。

`JUL2605` 已設 `Driver Payable Override HKD = 0`，因此不會錯誤扣除香港司機費。

## Monthly Finance 修復

舊程式使用了與 Airtable 不一致的欄位名，例如 `Total Revenue`，而正式欄位是 `Total Revenue HKD`，令 Order Count 已更新但收入、成本及支出仍停留在舊數。

v4.6 已改為寫入現有正式欄位：

- `Total Revenue HKD`
- `Supplier Cost HKD`
- `China Freight HKD`
- `Local Delivery Cost HKD`
- `Reissue Cost HKD`
- `Order Gross Profit HKD`
- `Marketing Spend HKD`
- `Business Expenses HKD`

訂單毛利由收入減小糖成本、中國運費、實際司機費及補寄成本重新計算，不再沿用未扣新司機費規則的舊 Profit formula。

## Dashboard

- 成本分拆只顯示 `實際司機費`，不另外顯示報價已收運費或公司保留的 10%。
- 新增「司機付款（按到港批次）」：
  - 顯示同一 China Shipment 要過給司機的總額；
  - 混合月份批次會按各 Order 原本月份拆開成本；
  - 財務月份不跟 Shipment Date、Delivery Date 或實際付款日。

例如同一批有六月及七月 Order，Dashboard 會同時顯示整批付款總額，以及六月／七月各自應入帳的司機成本。

## 目前已校正

- `SF0215715540919` 已連接 `JUN2602`、`JUN2603`、`JUL2601`–`JUL2604`。
- 按實際報價香港運費 90% 計：
  - 六月部分：HK$459.90
  - 七月部分：HK$936.00
  - 整批司機費：HK$1,395.90
- 以上使用 Airtable 現有報價金額自動計算；不是把示例金額寫死。

## 部署

1. 將本更新包內容完整覆蓋 Quote System GitHub repo。
2. Commit / Push。
3. 等 Railway 自動重新部署。
4. 開啟 `/admin/dashboard?month=2026-06` 及 `/admin/dashboard?month=2026-07` 驗證。

不需要新增 Railway Variables。Delivery System 暫時維持現有正式版本，下一步才處理。
