export type ChinaShipmentInputItem = {
  orderItemRecordId: string;
  itemLabel: string;
  linkedChinaShipmentIds: string[];
  pieceWeightsKg: Array<string | number>;
};

export type ChinaShipmentInput = {
  shipmentNo: string | null;
  shipmentDate: string;
  sfFreightRmb: string | number;
  sfActualWeightKg: string | number | null;
  sfChargeableWeightKg: string | number | null;
  items: ChinaShipmentInputItem[];
};

export type ChinaShipmentItemUpdate = {
  id: string;
  fields: {
    'China Freight Piece Count': number;
    'China Freight Piece Weights KG': string;
    'China Freight Weight Input KG': number;
  };
};

export type ChinaShipmentWritePlan = {
  shipmentNo: string;
  itemUpdates: ChinaShipmentItemUpdate[];
  shipmentFields: {
    'Shipment No.': string;
    'Shipment Date': string;
    'Order Items': string[];
    'SF Freight RMB': number;
    'SF Actual Weight KG'?: number;
    'SF Chargeable Weight KG'?: number;
  };
  itemCount: number;
  pieceCount: number;
  totalWeightKg: number;
};

const optionalNonNegativeNumber = (raw: unknown, label: string): number | null => {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} 必須係 0 或以上。`);
  return value;
};

/**
 * Builds the one canonical Airtable write plan used by both the existing
 * owner cost page and the Supplier Portal receiver.
 *
 * This deliberately keeps the current business behaviour: each Order Item
 * receives its China parcel count, newline-separated parcel weights and
 * summed allocation weight; the China Shipment receives the same header and
 * linked Order Item IDs. Airtable remains responsible for the existing
 * freight allocation formula.
 */
export const buildChinaShipmentWritePlan = (
  input: ChinaShipmentInput,
  generateShipmentNo: (shipmentDate: string) => string,
): ChinaShipmentWritePlan => {
  const shipmentDate = String(input.shipmentDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shipmentDate)) throw new Error('請輸入正確 Shipment Date。');

  const sfFreightRmb = Number(input.sfFreightRmb);
  if (!Number.isFinite(sfFreightRmb) || sfFreightRmb <= 0) {
    throw new Error('整批 SF Freight RMB 必須大過 0。');
  }
  const sfActualWeight = optionalNonNegativeNumber(input.sfActualWeightKg, 'SF Actual Weight KG');
  const sfChargeableWeight = optionalNonNegativeNumber(input.sfChargeableWeightKg, 'SF Chargeable Weight KG');

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('請至少選擇一個 Order Item。');
  }
  const selectedItemIds = input.items.map(item => String(item.orderItemRecordId || '').trim());
  if (selectedItemIds.some(itemId => !itemId)) throw new Error('Order Item資料不完整，請重新整理再試。');
  if (new Set(selectedItemIds).size !== selectedItemIds.length) {
    throw new Error('Order Item 選擇重複，請重新整理再試。');
  }

  let totalWeightKg = 0;
  let pieceCount = 0;
  const itemUpdates: ChinaShipmentItemUpdate[] = input.items.map(item => {
    const itemId = String(item.orderItemRecordId).trim();
    const itemLabel = String(item.itemLabel || itemId);
    if (item.linkedChinaShipmentIds.length > 0) {
      throw new Error(`${itemLabel} 已連接其他 China Shipment，今次冇建立重複批次。`);
    }
    if (!Array.isArray(item.pieceWeightsKg) || item.pieceWeightsKg.length < 1 || item.pieceWeightsKg.length > 100) {
      throw new Error(`請輸入 ${itemLabel} 正確嘅貨物件數（1–100）。`);
    }
    const weights = item.pieceWeightsKg.map((rawWeight, index) => {
      const weight = Number(rawWeight);
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error(`請輸入 ${itemLabel} 第 ${index + 1} 件貨嘅實際重量。`);
      }
      return weight;
    });
    const itemWeight = weights.reduce((sum, weight) => sum + weight, 0);
    totalWeightKg += itemWeight;
    pieceCount += weights.length;
    return {
      id: itemId,
      fields: {
        'China Freight Piece Count': weights.length,
        'China Freight Piece Weights KG': weights.join('\n'),
        'China Freight Weight Input KG': Number(itemWeight.toFixed(3)),
      },
    };
  });

  const requestedShipmentNo = String(input.shipmentNo || '').trim();
  const shipmentNo = requestedShipmentNo || generateShipmentNo(shipmentDate);
  if (!shipmentNo) throw new Error('未能建立 Shipment No.。');

  const shipmentFields: ChinaShipmentWritePlan['shipmentFields'] = {
    'Shipment No.': shipmentNo,
    'Shipment Date': shipmentDate,
    'Order Items': selectedItemIds,
    'SF Freight RMB': sfFreightRmb,
  };
  if (sfActualWeight !== null) shipmentFields['SF Actual Weight KG'] = sfActualWeight;
  if (sfChargeableWeight !== null) shipmentFields['SF Chargeable Weight KG'] = sfChargeableWeight;

  return {
    shipmentNo,
    itemUpdates,
    shipmentFields,
    itemCount: itemUpdates.length,
    pieceCount,
    totalWeightKg,
  };
};
