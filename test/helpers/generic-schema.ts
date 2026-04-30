import type { ProtectedFieldDefinition } from "../../src/field-schema.js";

export const shopFieldSchema: ProtectedFieldDefinition[] = [
  {
    fieldId: "shop_name",
    flag: "--shop-name",
    label: "门店名称",
    valueType: "string",
    readPath: "shop.name",
    requiredInPayload: true
  },
  {
    fieldId: "enabled",
    flag: "--enabled",
    label: "营业状态",
    valueType: "boolean",
    readPath: "enabled",
    requiredInPayload: true
  },
  {
    fieldId: "min_order_price",
    flag: "--min-order-price",
    label: "起送门槛",
    valueType: "decimal",
    readPath: "delivery.min_order_price",
    requiredInPayload: true
  }
];

export const shopBeforeSnapshot = {
  shop: {
    name: "Old Shop"
  },
  enabled: true,
  delivery: {
    min_order_price: 20
  },
  updated_at: "2026-04-29T00:00:00"
} satisfies Record<string, unknown>;
