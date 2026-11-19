1. Chat / collaboration (ngoài Slack, Teams, Chatwork)
● LINE WORKS
Rất quan trọng ở Nhật (giống LINE nhưng cho doanh nghiệp)
Có API + bot
Dùng nhiều trong sales / logistics / retail
👉 Rất hợp để làm automation kiểu “message → workflow”
● Discord (ít trong doanh nghiệp Nhật truyền thống)
Nhưng startup / AI team có dùng
2. Project / Issue tracking
● Nulab – Backlog
Rất phổ biến ở Nhật (đối thủ Jira nội địa)
API tốt, dễ integrate
Dùng cho dev team, PM

👉 Đây là tool rất “Japan-heavy”, cực đáng connect Activepieces

● Jira (Atlassian)
Dùng nhiều ở công ty IT Nhật + enterprise global
Webhook mạnh
● Trello / Asana / ClickUp
Startup Nhật dùng nhiều hơn
3. Workflow / ERP / Business system (rất quan trọng ở Nhật)
● Cybozu – kintone
Siêu phổ biến ở SME Nhật
Dùng để build workflow nội bộ (no-code)
API + webhook mạnh → rất hợp Activepieces
● Sansan
CRM + contact management (card business digital hóa)
Rất nhiều công ty Nhật dùng
API tốt cho automation sales pipeline
● freee
Kế toán / accounting cloud cực phổ biến ở SME
Có API để sync invoice, payment
● Money Forward
Cạnh tranh trực tiếp freee
HR + accounting + expense management
● SmartHR
HR system (onboarding, payroll, employee data)
API rất hữu ích cho automation HR
4. CRM / Sales / Support
● Salesforce
Rất phổ biến trong enterprise Nhật
API + webhook cực mạnh
● HubSpot
Startup + mid-size company
● Zendesk
Customer support ticket system
5. File / document / storage
● Google Workspace
Gmail, Drive, Docs (rất phổ biến trong IT + startup)
● Microsoft 365
Outlook, Excel, SharePoint (enterprise Nhật cực nhiều)
● Box
Enterprise file storage (rất mạnh ở Nhật)
6. Email / notification (cực quan trọng cho Activepieces)
Gmail / Outlook (SMTP + API)
Webhook email parser
SendGrid / Amazon SES

👉 Nhật vẫn dùng email rất nhiều trong workflow nội bộ

7. RPA / automation (đặc sản Nhật)
● UiPath
Enterprise automation mạnh
● WinActor (NEC Japan)
RPA rất phổ biến trong ngân hàng / government

👉 Đây là nơi Activepieces có thể “thay thế nhẹ” hoặc integrate

Gợi ý quan trọng cho Activepieces integration

Nếu bạn build system như bạn đang nói (Chatwork → FastAPI → LangChain / LangGraph), thì các integration quan trọng nhất ở Nhật là:

🔥 Top priority connectors
LINE WORKS
Chatwork
kintone
Backlog
Salesforce
Microsoft Teams
Google Workspace
freee / Money Forward
SmartHR
Nếu bạn muốn build serious product

Bạn nên nghĩ theo 3 layer:

1. Trigger layer
Chatwork message
LINE WORKS message
Email inbound
Webhook
2. Business system layer
kintone / Backlog / Salesforce / HR / accounting
3. AI layer (LangChain / LangGraph)
classify message
route workflow
generate response