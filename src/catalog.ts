import type { MutationOperation } from "./intent-types.js";

export type ParameterValueType =
  | "string"
  | "boolean"
  | "integer"
  | "decimal"
  | "datetime"
  | "time-range"
  | "tier-list"
  | "enum"
  | "json";

export interface ParameterCatalogItem {
  fieldId: string;
  labels: string[];
  aliases: string[];
  description: string;
  valueType: ParameterValueType;
  apiPath: string;
  requiredInWritePayload: boolean;
  supportsOperations: MutationOperation[];
}

export type ParameterCatalog = readonly ParameterCatalogItem[];

export const FULL_REDUCTION_TIER_SCALAR_FIELD_IDS = [
  "tier_1_threshold",
  "tier_1_discount",
  "tier_2_threshold",
  "tier_2_discount",
  "tier_3_threshold",
  "tier_3_discount"
] as const;

export const parameterCatalog: ParameterCatalog = [
  {
    fieldId: "activity_name",
    labels: ["活动名称", "activity_name"],
    aliases: ["活动名称", "名称", "activity_name"],
    description: "Activity display name",
    valueType: "string",
    apiPath: "activity_name",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "activity_status",
    labels: ["活动状态", "activity_status"],
    aliases: ["活动状态", "活动开关", "activity_status"],
    description: "Whether the activity is enabled or disabled",
    valueType: "enum",
    apiPath: "activity_status",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "start_time",
    labels: ["开始时间", "start_time"],
    aliases: ["开始时间", "起始时间", "start_time"],
    description: "Activity start datetime",
    valueType: "datetime",
    apiPath: "start_time",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "end_time",
    labels: ["结束时间", "end_time"],
    aliases: ["结束时间", "截止时间", "end_time"],
    description: "Activity end datetime",
    valueType: "datetime",
    apiPath: "end_time",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "weekday_mask",
    labels: ["生效星期", "weekday_mask"],
    aliases: ["生效星期", "weekday_mask", "星期掩码"],
    description: "Weekday mask as a 7-bit 0/1 string",
    valueType: "string",
    apiPath: "weekday_mask",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "min_order_price",
    labels: ["起送门槛", "min_order_price"],
    aliases: ["起送门槛", "最低消费", "min_order_price"],
    description: "Minimum order amount",
    valueType: "decimal",
    apiPath: "min_order_price",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "delivery_fee_discount",
    labels: ["配送费减免", "delivery_fee_discount"],
    aliases: ["配送费减免", "运费减免", "delivery_fee_discount"],
    description: "Delivery fee discount amount",
    valueType: "decimal",
    apiPath: "delivery_fee_discount",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "full_reduction_tiers",
    labels: ["满减档位", "full_reduction_tiers"],
    aliases: ["满减", "满减档位", "满减梯度", "full reduction tiers"],
    description: "Promotion full reduction tiers such as 25-15 or 40-20",
    valueType: "tier-list",
    apiPath: "promotion.full_reduction_tiers",
    requiredInWritePayload: true,
    supportsOperations: ["replace_item"]
  },
  {
    fieldId: "tier_1_threshold",
    labels: ["第一档门槛", "tier_1_threshold"],
    aliases: ["第一档门槛", "tier_1_threshold", "一档门槛"],
    description: "Tier 1 threshold amount",
    valueType: "decimal",
    apiPath: "tier_1_threshold",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "tier_1_discount",
    labels: ["第一档优惠", "tier_1_discount"],
    aliases: ["第一档优惠", "tier_1_discount", "一档优惠"],
    description: "Tier 1 discount amount",
    valueType: "decimal",
    apiPath: "tier_1_discount",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "tier_2_threshold",
    labels: ["第二档门槛", "tier_2_threshold"],
    aliases: ["第二档门槛", "tier_2_threshold", "二档门槛"],
    description: "Tier 2 threshold amount",
    valueType: "decimal",
    apiPath: "tier_2_threshold",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "tier_2_discount",
    labels: ["第二档优惠", "tier_2_discount"],
    aliases: ["第二档优惠", "tier_2_discount", "二档优惠"],
    description: "Tier 2 discount amount",
    valueType: "decimal",
    apiPath: "tier_2_discount",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "tier_3_threshold",
    labels: ["第三档门槛", "tier_3_threshold"],
    aliases: ["第三档门槛", "tier_3_threshold", "三档门槛"],
    description: "Tier 3 threshold amount",
    valueType: "decimal",
    apiPath: "tier_3_threshold",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "tier_3_discount",
    labels: ["第三档优惠", "tier_3_discount"],
    aliases: ["第三档优惠", "tier_3_discount", "三档优惠"],
    description: "Tier 3 discount amount",
    valueType: "decimal",
    apiPath: "tier_3_discount",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "stack_with_coupon",
    labels: ["优惠券叠加", "stack_with_coupon"],
    aliases: ["优惠券叠加", "是否与优惠券叠加", "stack_with_coupon"],
    description: "Whether coupons can be stacked",
    valueType: "boolean",
    apiPath: "stack_with_coupon",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "stack_with_membership",
    labels: ["会员折扣叠加", "stack_with_membership"],
    aliases: ["会员折扣叠加", "是否与会员折扣叠加", "stack_with_membership"],
    description: "Whether membership discounts can be stacked",
    valueType: "boolean",
    apiPath: "stack_with_membership",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "new_customer_only",
    labels: ["仅新客可用", "new_customer_only"],
    aliases: ["仅新客可用", "是否仅新客可用", "new_customer_only"],
    description: "Whether the activity is only for new customers",
    valueType: "boolean",
    apiPath: "new_customer_only",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "vip_only",
    labels: ["仅会员可用", "vip_only"],
    aliases: ["仅会员可用", "是否仅会员可用", "vip_only"],
    description: "Whether the activity is only for VIP users",
    valueType: "boolean",
    apiPath: "vip_only",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "budget_limit",
    labels: ["预算上限", "budget_limit"],
    aliases: ["预算上限", "活动预算", "budget_limit"],
    description: "Campaign budget limit",
    valueType: "decimal",
    apiPath: "budget_limit",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  },
  {
    fieldId: "remark",
    labels: ["备注", "remark"],
    aliases: ["备注", "remark", "运营备注"],
    description: "Operator remark",
    valueType: "string",
    apiPath: "remark",
    requiredInWritePayload: true,
    supportsOperations: ["set"]
  }
];
