import { AttributionBusinessAdapter } from '../attribution-business';
import { AttributionSnapshot } from '../attribution-store';

export class SyntheticAttributionBusiness implements AttributionBusinessAdapter {
  readonly attributions = new Map<string, { snapshot: AttributionSnapshot; firstCampaign: string | null; lastCampaign: string | null }>();
  readonly inquiries = new Map<string, { first: AttributionSnapshot; latest: AttributionSnapshot }>();
  readonly quotes = new Map<string, AttributionSnapshot | null>();
  readonly quoteReasons = new Map<string, string | null>();
  readonly orders = new Map<string, AttributionSnapshot | null>();

  constructor(private readonly campaigns = new Map<string, { source: string; recordId: string }>()) {}

  private project(snapshot: AttributionSnapshot): void {
    const campaign = (key: string | null, source: string): string | null => {
      const match = key ? this.campaigns.get(key) : undefined;
      return match && match.source === source ? match.recordId : null;
    };
    if (!this.attributions.has(snapshot.shortCode)) this.attributions.set(snapshot.shortCode, {
      snapshot: structuredClone(snapshot),
      firstCampaign: campaign(snapshot.firstTouch.campaignKey, snapshot.firstTouch.source),
      lastCampaign: campaign(snapshot.lastTouch.campaignKey, snapshot.lastTouch.source),
    });
  }

  attachInquiry(inquiryId: string, snapshot: AttributionSnapshot): true {
    this.project(snapshot);
    const previous = this.inquiries.get(inquiryId);
    this.inquiries.set(inquiryId, {
      first: previous?.first || structuredClone(snapshot),
      latest: structuredClone(snapshot),
    });
    return true;
  }

  pinQuote(quoteId: string, inquiryId: string, snapshot: AttributionSnapshot | null, reason: string | null): true {
    if (this.quotes.has(quoteId)) return true;
    if (snapshot && inquiryId) this.attachInquiry(inquiryId, snapshot);
    this.quotes.set(quoteId, snapshot ? structuredClone(snapshot) : null);
    this.quoteReasons.set(quoteId, reason);
    return true;
  }

  copyQuoteToOrder(quoteId: string, orderId: string): true {
    if (this.orders.has(orderId)) return true;
    const snapshot = this.quotes.get(quoteId);
    this.orders.set(orderId, snapshot ? structuredClone(snapshot) : null);
    return true;
  }
}
