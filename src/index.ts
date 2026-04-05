import express, { Request, Response } from 'express';
import Airtable from 'airtable';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Check env vars
const requiredEnvVars = [
  'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID',
  'AIRTABLE_TABLE_CUSTOMERS',
  'AIRTABLE_TABLE_ORDERS',
  'AIRTABLE_TABLE_ORDER_ITEMS',
  'AIRTABLE_TABLE_QUOTES'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Airtable Setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID!);
const tableCustomers = base(process.env.AIRTABLE_TABLE_CUSTOMERS!);
const tableOrders = base(process.env.AIRTABLE_TABLE_ORDERS!);
const tableOrderItems = base(process.env.AIRTABLE_TABLE_ORDER_ITEMS!);
const tableQuotes = base(process.env.AIRTABLE_TABLE_QUOTES!);

// Helpers
const generateToken = () => crypto.randomBytes(16).toString('hex');
const escapeHtml = (unsafe: string) => {
  return (unsafe || '').toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

const getNextNumber = async (table: Airtable.Table<any>, field: string, prefix: string) => {
  const records = await table.select({
    fields: [field],
    sort: [{ field: field, direction: 'desc' }],
    maxRecords: 1
  }).firstPage();

  if (records.length === 0 || !records[0].get(field)) {
    return `${prefix}-2026-0001`;
  }
  
  const lastNumber = records[0].get(field) as string;
  const match = lastNumber.match(/-(\d+)$/);
  if (match) {
    const nextNum = parseInt(match[1], 10) + 1;
    return `${prefix}-2026-${nextNum.toString().padStart(4, '0')}`;
  }
  return `${prefix}-2026-0001`;
};

// HTML Template Helper
const renderPage = (title: string, content: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6; color: #333; line-height: 1.6; padding: 20px; }
    .container { max-width: 800px; margin: 0 auto; background: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    h1, h2, h3 { color: #111; }
    .header { border-bottom: 2px solid #eee; padding-bottom: 20px; margin-bottom: 20px; }
    .company-info { color: #666; font-size: 0.9em; }
    .items-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .items-table th, .items-table td { border: 1px solid #ddd; padding: 12px; text-align: left; }
    .items-table th { background-color: #f9fafb; }
    .totals { text-align: right; margin-top: 20px; }
    .totals p { margin: 5px 0; }
    .totals strong { font-size: 1.2em; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; margin-bottom: 5px; font-weight: bold; }
    .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    button { background-color: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
    button:hover { background-color: #0056b3; }
    .alert { padding: 15px; margin-bottom: 20px; border: 1px solid transparent; border-radius: 4px; }
    .alert-success { color: #155724; background-color: #d4edda; border-color: #c3e6cb; }
    .alert-danger { color: #721c24; background-color: #f8d7da; border-color: #f5c6cb; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; color: white; }
    .badge-draft { background: #6c757d; }
    .badge-pending { background: #ffc107; color: #000; }
    .badge-converted { background: #28a745; }
    .badge-paid { background: #28a745; }
    .badge-unpaid { background: #dc3545; }
  </style>
</head>
<body>
  <div class="container">
    ${content}
  </div>
</body>
</html>
`;

// --- Routes ---

// GET /quote/create
app.get('/quote/create', (req: Request, res: Response) => {
  const html = renderPage('Create Quote', `
    <h1>Create New Quote</h1>
    <form action="/quote/create" method="POST">
      <div class="form-group">
        <label>Contact Name</label>
        <input type="text" name="contactName" required>
      </div>
      <div class="form-group">
        <label>Phone</label>
        <input type="text" name="phone" required>
      </div>
      <div class="form-group">
        <label>Contact Method</label>
        <select name="contactMethod" required>
          <option value="WhatsApp">WhatsApp</option>
          <option value="IG">IG</option>
          <option value="Facebook">Facebook</option>
          <option value="Phone">Phone</option>
        </select>
      </div>
      <div class="form-group">
        <label>Contact Handle / Reference</label>
        <input type="text" name="contactHandle">
      </div>
      <div class="form-group">
        <label>Items JSON (Array of { description, qty, price, amount, size?, accessories? })</label>
        <textarea name="itemsJson" rows="8" required>[
  {
    "description": "Display Case",
    "qty": 1,
    "price": 3200,
    "amount": 3200
  }
]</textarea>
      </div>
      <div class="form-group">
        <label>Subtotal</label>
        <input type="number" name="subtotal" step="0.01" required>
      </div>
      <div class="form-group">
        <label>Discount</label>
        <input type="number" name="discount" step="0.01" value="0">
      </div>
      <div class="form-group">
        <label>Total</label>
        <input type="number" name="total" step="0.01" required>
      </div>
      <div class="form-group">
        <label>Description Summary</label>
        <input type="text" name="descriptionSummary">
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea name="notes" rows="3"></textarea>
      </div>
      <div class="form-group">
        <label>Terms and Conditions</label>
        <textarea name="terms" rows="4">Standard Terms and Conditions apply.</textarea>
      </div>
      <div class="form-group">
        <label>Valid Until (YYYY-MM-DD)</label>
        <input type="date" name="validUntil">
      </div>
      <button type="submit">Generate Quote</button>
    </form>
  `);
  res.send(html);
});

// POST /quote/create
app.post('/quote/create', async (req: Request, res: Response) => {
  try {
    const { contactName, phone, contactMethod, contactHandle, itemsJson, subtotal, discount, total, descriptionSummary, notes, terms, validUntil } = req.body;
    
    // Validate JSON
    try {
      JSON.parse(itemsJson);
    } catch (e) {
      return res.status(400).send(renderPage('Error', '<div class="alert alert-danger">Invalid Items JSON format.</div><a href="/quote/create">Back</a>'));
    }

    const quoteNumber = await getNextNumber(tableQuotes, 'Quote Number', 'QT');
    const publicToken = generateToken();
    const quoteDate = new Date().toISOString().split('T')[0];

    await tableQuotes.create([
      {
        fields: {
          'Quote Number': quoteNumber,
          'Quote Date': quoteDate,
          'Status': 'Draft',
          'Public Token': publicToken,
          'Valid Until': validUntil || null,
          'Contact Name': contactName,
          'Phone': phone,
          'Contact Method': contactMethod,
          'Contact Handle / Reference': contactHandle,
          'Sub Total': parseFloat(subtotal),
          'Discount': parseFloat(discount) || 0,
          'Total': parseFloat(total),
          'Description Summary': descriptionSummary,
          'Quote Items JSON': itemsJson,
          'Notes': notes,
          'Terms and Conditions': terms,
          'Created At': new Date().toISOString()
        }
      }
    ]);

    const publicLink = `${PUBLIC_BASE_URL}/quote/${publicToken}`;
    res.send(renderPage('Quote Created', `
      <div class="alert alert-success">Quote Created Successfully!</div>
      <p><strong>Quote Number:</strong> ${quoteNumber}</p>
      <p><strong>Public Link:</strong> <a href="${publicLink}" target="_blank">${publicLink}</a></p>
      <br>
      <a href="/quote/create">Create Another Quote</a>
    `));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error creating quote: ${error.message}</div>`));
  }
});

// GET /quote/:token
app.get('/quote/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const records = await tableQuotes.select({ filterByFormula: `{Public Token} = '${token}'` }).firstPage();
    
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', 'Quote not found.'));
    
    const quote = records[0].fields;
    const status = quote['Status'] as string;
    const itemsJson = quote['Quote Items JSON'] as string;
    let items = [];
    try { items = JSON.parse(itemsJson); } catch (e) { console.error('Error parsing items JSON'); }

    let itemsHtml = items.map((item: any) => `
      <tr>
        <td>
          ${escapeHtml(item.description)}
          ${item.size ? `<br><small>Size: ${escapeHtml(item.size)}</small>` : ''}
          ${item.accessories ? `<br><small>Accessories: ${escapeHtml(item.accessories)}</small>` : ''}
        </td>
        <td>${item.qty}</td>
        <td>$${item.price}</td>
        <td>$${item.amount}</td>
      </tr>
    `).join('');

    let statusBadge = 'badge-draft';
    if (status === 'Pending Order') statusBadge = 'badge-pending';
    else if (status === 'Converted to Invoice') statusBadge = 'badge-converted';

    let content = `
      <div class="header">
        <h1>Quote ${escapeHtml(quote['Quote Number'] as string)} <span class="badge ${statusBadge}">${escapeHtml(status)}</span></h1>
        <div class="company-info">
          <p><strong>${process.env.COMPANY_NAME}</strong><br>
          Phone: ${process.env.COMPANY_PHONE}<br>
          Email: ${process.env.COMPANY_EMAIL}<br>
          Address: ${process.env.COMPANY_ADDRESS}</p>
        </div>
        <p><strong>Date:</strong> ${escapeHtml(quote['Quote Date'] as string)}</p>
        ${quote['Valid Until'] ? `<p><strong>Valid Until:</strong> ${escapeHtml(quote['Valid Until'] as string)}</p>` : ''}
      </div>

      <h3>Items</h3>
      <table class="items-table">
        <thead>
          <tr>
            <th>Description</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <div class="totals">
        <p>Subtotal: $${quote['Sub Total']}</p>
        ${quote['Discount'] ? `<p>Discount: -$${quote['Discount']}</p>` : ''}
        <p><strong>Total: $${quote['Total']}</strong></p>
      </div>

      ${quote['Notes'] ? `<div><h3>Notes</h3><p>${escapeHtml(quote['Notes'] as string).replace(/\\n/g, '<br>')}</p></div>` : ''}
      ${quote['Terms and Conditions'] ? `<div><h3>Terms and Conditions</h3><p>${escapeHtml(quote['Terms and Conditions'] as string).replace(/\\n/g, '<br>')}</p></div>` : ''}
    `;

    if (status === 'Draft') {
      content += `
        <hr>
        <h2>Confirm Order</h2>
        <form action="/quote/${token}/submit" method="POST">
          <div class="form-group">
            <label>Name</label>
            <input type="text" name="customerName" required>
          </div>
          <div class="form-group">
            <label>Phone</label>
            <input type="text" name="customerPhone" required>
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" name="customerEmail" required>
          </div>
          <div class="form-group">
            <label>Chinese Delivery Address</label>
            <textarea name="chineseDeliveryAddress" rows="3" required></textarea>
          </div>
          <div class="form-group">
            <label>Payment Method</label>
            <select name="paymentMethod" required>
              <option value="FPS">FPS</option>
              <option value="Bank Transfer">Bank Transfer</option>
              <option value="PayMe">PayMe</option>
            </select>
          </div>
          <div class="form-group">
            <label>How did you know us? (Optional)</label>
            <select name="howDidYouKnowUs">
              <option value="">-- Select --</option>
              <option value="朋友介紹">朋友介紹</option>
              <option value="Facebook">Facebook</option>
              <option value="IG">IG</option>
              <option value="網站搜尋 Google">網站搜尋 Google</option>
            </select>
          </div>
          <button type="submit">Confirm Order</button>
        </form>
      `;
    } else {
      content += `<div class="alert alert-success">This quote has been submitted and is currently: <strong>${status}</strong>.</div>`;
    }

    res.send(renderPage(`Quote ${quote['Quote Number']}`, content));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error fetching quote: ${error.message}</div>`));
  }
});

// POST /quote/:token/submit
app.post('/quote/:token/submit', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { customerName, customerPhone, customerEmail, chineseDeliveryAddress, paymentMethod, howDidYouKnowUs } = req.body;

    const records = await tableQuotes.select({ filterByFormula: `{Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', 'Quote not found.'));
    
    const record = records[0];
    if (record.fields['Status'] !== 'Draft') {
      return res.status(400).send(renderPage('Error', '<div class="alert alert-danger">This quote has already been submitted or converted.</div>'));
    }

    await tableQuotes.update([{
      id: record.id,
      fields: {
        'Customer Name': customerName,
        'Customer Phone': customerPhone,
        'Customer Email': customerEmail,
        'Chinese Delivery Address': chineseDeliveryAddress,
        'Payment Method': paymentMethod,
        'How Did You Know Us': howDidYouKnowUs || null,
        'Status': 'Pending Order',
        'Customer Submitted At': new Date().toISOString()
      }
    }]);

    res.send(renderPage('Order Confirmed', `
      <div class="alert alert-success">
        <h2>Thank you for your order!</h2>
        <p>Your order has been confirmed. We will review it and send you an invoice shortly.</p>
        <p><a href="/quote/${token}">Back to Quote</a></p>
      </div>
    `));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error submitting quote: ${error.message}</div>`));
  }
});

// POST /admin/quote/:token/convert
app.post('/admin/quote/:token/convert', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const records = await tableQuotes.select({ filterByFormula: `{Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', 'Quote not found.'));
    
    const quote = records[0];
    if (quote.fields['Status'] !== 'Pending Order') {
      return res.status(400).send(renderPage('Error', '<div class="alert alert-danger">Only Pending Order quotes can be converted.</div>'));
    }

    const customerPhone = quote.fields['Customer Phone'] as string;
    const customerName = quote.fields['Customer Name'] as string;
    const customerEmail = quote.fields['Customer Email'] as string;
    const customerAddress = quote.fields['Chinese Delivery Address'] as string;

    if (!customerPhone || !customerName) {
      return res.status(400).send(renderPage('Error', '<div class="alert alert-danger">Missing customer phone or name.</div>'));
    }

    // A. Customers
    let customerRecordId: string;
    const existingCustomers = await tableCustomers.select({ filterByFormula: `{Phone} = '${customerPhone}'` }).firstPage();
    
    if (existingCustomers.length > 0) {
      customerRecordId = existingCustomers[0].id;
      await tableCustomers.update([{
        id: customerRecordId,
        fields: {
          'Customer Name': customerName,
          'Email': customerEmail,
          'Address': customerAddress
        }
      }]);
    } else {
      const newCustomer = await tableCustomers.create([{
        fields: {
          'Customer Name': customerName,
          'Phone': customerPhone,
          'Email': customerEmail,
          'Address': customerAddress
        }
      }]);
      customerRecordId = newCustomer[0].id;
    }

    // B. Order_2026
    const internalOrderNo = await getNextNumber(tableOrders, 'Internal Order No', 'ORD');
    const invoiceNumber = await getNextNumber(tableOrders, 'Invoice Number', 'INV');
    const invoicePublicToken = generateToken();
    const invoiceDate = new Date().toISOString().split('T')[0];

    const newOrder = await tableOrders.create([{
      fields: {
        'Internal Order No': internalOrderNo,
        'Invoice Number': invoiceNumber,
        'Invoice Public Token': invoicePublicToken,
        'Customer Ref': [customerRecordId],
        'Product Amount': quote.fields['Sub Total'],
        'Discount': quote.fields['Discount'],
        'Final Amount': quote.fields['Total'],
        'Payment Method': quote.fields['Payment Method'],
        'Invoice Date': invoiceDate,
        'Status': 'Unpaid',
        'Description': quote.fields['Description Summary'],
        'Notes': quote.fields['Notes'],
        'Terms and Conditions': quote.fields['Terms and Conditions'],
        'Source Quote Ref': [quote.id]
      }
    }]);

    const orderRecordId = newOrder[0].id;

    // C. Order Items
    const itemsJson = quote.fields['Quote Items JSON'] as string;
    let items = [];
    try { items = JSON.parse(itemsJson); } catch (e) { console.error('Error parsing items JSON'); }

    const orderItemsPromises = items.map((item: any) => {
      const fields: any = {
        'Order Ref': [orderRecordId],
        'Description': item.description,
        'Qty': parseInt(item.qty, 10),
        'Price': parseFloat(item.price),
        'Amount': parseFloat(item.amount)
      };
      if (item.size) fields['尺寸'] = item.size;
      if (item.accessories) fields['Accessories'] = item.accessories;
      return { fields };
    });

    if (orderItemsPromises.length > 0) {
      await tableOrderItems.create(orderItemsPromises);
    }

    // D. Update Quote
    await tableQuotes.update([{
      id: quote.id,
      fields: {
        'Status': 'Converted to Invoice',
        'Converted Order No': internalOrderNo,
        'Converted Invoice No': invoiceNumber,
        'Customer Ref': [customerRecordId],
        'Order Ref': [orderRecordId],
        'Converted At': new Date().toISOString()
      }
    }]);

    res.send(renderPage('Quote Converted', `
      <div class="alert alert-success">Successfully converted to Invoice!</div>
      <p><strong>Invoice Number:</strong> ${invoiceNumber}</p>
      <p><strong>Invoice Link:</strong> <a href="/invoice/${invoicePublicToken}" target="_blank">/invoice/${invoicePublicToken}</a></p>
      <p><a href="/quote/${token}">Back to Quote</a></p>
    `));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error converting quote: ${error.message}</div>`));
  }
});

// GET /invoice/:token
app.get('/invoice/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const records = await tableOrders.select({ filterByFormula: `{Invoice Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', 'Invoice not found.'));
    
    const order = records[0].fields;
    const customerRef = order['Customer Ref'] as string[];
    
    let customerHtml = '';
    if (customerRef && customerRef.length > 0) {
      const customerRecord = await tableCustomers.find(customerRef[0]);
      if (customerRecord) {
        customerHtml = `
          <h3>Customer Information</h3>
          <p>
            <strong>Name:</strong> ${escapeHtml(customerRecord.fields['Customer Name'] as string)}<br>
            <strong>Phone:</strong> ${escapeHtml(customerRecord.fields['Phone'] as string)}<br>
            <strong>Email:</strong> ${escapeHtml(customerRecord.fields['Email'] as string)}<br>
            <strong>Address:</strong> ${escapeHtml(customerRecord.fields['Address'] as string)}
          </p>
        `;
      }
    }

    const orderId = records[0].id;
    const itemRecords = await tableOrderItems.select({ filterByFormula: `SEARCH('${orderId}', ARRAYJOIN({Order Ref})) > 0` }).firstPage();
    
    let itemsHtml = itemRecords.map((item: any) => `
      <tr>
        <td>
          ${escapeHtml(item.fields['Description'] as string)}
          ${item.fields['尺寸'] ? `<br><small>Size: ${escapeHtml(item.fields['尺寸'] as string)}</small>` : ''}
          ${item.fields['Accessories'] ? `<br><small>Accessories: ${escapeHtml(item.fields['Accessories'] as string)}</small>` : ''}
        </td>
        <td>${item.fields['Qty']}</td>
        <td>$${item.fields['Price']}</td>
        <td>$${item.fields['Amount']}</td>
      </tr>
    `).join('');

    const status = order['Status'] as string;
    let statusBadge = 'badge-unpaid';
    if (status === 'Paid') statusBadge = 'badge-paid';

    let content = `
      <div class="header">
        <h1>Invoice ${escapeHtml(order['Invoice Number'] as string)} <span class="badge ${statusBadge}">${escapeHtml(status)}</span></h1>
        <div class="company-info">
          <p><strong>${process.env.COMPANY_NAME}</strong><br>
          Phone: ${process.env.COMPANY_PHONE}<br>
          Email: ${process.env.COMPANY_EMAIL}<br>
          Address: ${process.env.COMPANY_ADDRESS}</p>
        </div>
        <p><strong>Invoice Date:</strong> ${escapeHtml(order['Invoice Date'] as string)}</p>
        <p><strong>Due Date:</strong> ${escapeHtml(order['Invoice Date'] as string)}</p>
      </div>

      ${customerHtml}

      <h3>Items</h3>
      <table class="items-table">
        <thead>
          <tr>
            <th>Description</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <div class="totals">
        <p>Subtotal: $${order['Product Amount']}</p>
        ${order['Discount'] ? `<p>Discount: -$${order['Discount']}</p>` : ''}
        <p><strong>Total: $${order['Final Amount']}</strong></p>
        <p style="font-size: 1.3em; color: ${status === 'Paid' ? '#28a745' : '#dc3545'};">
          <strong>Balance Due: $${status === 'Paid' ? '0.00' : order['Final Amount']}</strong>
        </p>
      </div>

      ${order['Payment Method'] ? `<p><strong>Payment Method:</strong> ${escapeHtml(order['Payment Method'] as string)}</p>` : ''}
      ${order['Notes'] ? `<div><h3>Notes</h3><p>${escapeHtml(order['Notes'] as string).replace(/\\n/g, '<br>')}</p></div>` : ''}
      ${order['Terms and Conditions'] ? `<div><h3>Terms and Conditions</h3><p>${escapeHtml(order['Terms and Conditions'] as string).replace(/\\n/g, '<br>')}</p></div>` : ''}
    `;

    res.send(renderPage(`Invoice ${order['Invoice Number']}`, content));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error fetching invoice: ${error.message}</div>`));
  }
});

// POST /admin/invoice/:token/mark-paid
app.post('/admin/invoice/:token/mark-paid', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const records = await tableOrders.select({ filterByFormula: `{Invoice Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', 'Invoice not found.'));
    
    const order = records[0];
    if (order.fields['Status'] === 'Paid') {
      return res.status(400).send(renderPage('Error', '<div class="alert alert-danger">Invoice is already paid.</div>'));
    }

    const receiptNumber = await getNextNumber(tableOrders, 'Receipt Number', 'RCPT');
    const receiptPublicToken = generateToken();
    const payDate = new Date().toISOString().split('T')[0];

    await tableOrders.update([{
      id: order.id,
      fields: {
        'Status': 'Paid',
        'Pay Date': payDate,
        'Receipt Number': receiptNumber,
        'Receipt Public Token': receiptPublicToken
      }
    }]);

    res.send(renderPage('Marked as Paid', `
      <div class="alert alert-success">Invoice marked as paid successfully!</div>
      <p><strong>Receipt Number:</strong> ${receiptNumber}</p>
      <p><strong>Receipt Link:</strong> <a href="/receipt/${receiptPublicToken}" target="_blank">/receipt/${receiptPublicToken}</a></p>
      <p><a href="/invoice/${token}">Back to Invoice</a></p>
    `));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error marking as paid: ${error.message}</div>`));
  }
});

// GET /receipt/:token
app.get('/receipt/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const records = await tableOrders.select({ filterByFormula: `{Receipt Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', 'Receipt not found.'));
    
    const order = records[0].fields;
    const customerRef = order['Customer Ref'] as string[];
    
    let customerHtml = '';
    if (customerRef && customerRef.length > 0) {
      const customerRecord = await tableCustomers.find(customerRef[0]);
      if (customerRecord) {
        customerHtml = `
          <h3>Customer Information</h3>
          <p>
            <strong>Name:</strong> ${escapeHtml(customerRecord.fields['Customer Name'] as string)}<br>
            <strong>Phone:</strong> ${escapeHtml(customerRecord.fields['Phone'] as string)}<br>
            <strong>Email:</strong> ${escapeHtml(customerRecord.fields['Email'] as string)}<br>
            <strong>Address:</strong> ${escapeHtml(customerRecord.fields['Address'] as string)}
          </p>
        `;
      }
    }

    let content = `
      <div class="header">
        <h1>Receipt ${escapeHtml(order['Receipt Number'] as string)} <span class="badge badge-paid">Paid</span></h1>
        <div class="company-info">
          <p><strong>${process.env.COMPANY_NAME}</strong><br>
          Phone: ${process.env.COMPANY_PHONE}<br>
          Email: ${process.env.COMPANY_EMAIL}<br>
          Address: ${process.env.COMPANY_ADDRESS}</p>
        </div>
        <p><strong>Paid Date:</strong> ${escapeHtml(order['Pay Date'] as string)}</p>
        <p><strong>Related Invoice No:</strong> ${escapeHtml(order['Invoice Number'] as string)}</p>
      </div>

      ${customerHtml}

      <div class="totals" style="text-align: left; background: #f9fafb; padding: 20px; border-radius: 8px; margin-top: 20px;">
        <h3>Payment Details</h3>
        <p><strong>Paid Amount:</strong> $${order['Final Amount']}</p>
        <p><strong>Payment Method:</strong> ${escapeHtml(order['Payment Method'] as string)}</p>
      </div>

      ${order['Terms and Conditions'] ? `<div><h3>Terms and Conditions</h3><p>${escapeHtml(order['Terms and Conditions'] as string).replace(/\\n/g, '<br>')}</p></div>` : ''}
    `;

    res.send(renderPage(`Receipt ${order['Receipt Number']}`, content));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error fetching receipt: ${error.message}</div>`));
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Public Base URL: ${PUBLIC_BASE_URL}`);
});
