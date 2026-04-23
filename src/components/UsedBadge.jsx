import React from "react";

/**
 * UsedBadge — prominent badge for used/refurbished products.
 *
 * Variants:
 *   - "corner"  (default): overlay positioned absolutely top-right on a product image
 *   - "inline": inline-block badge for product titles
 *   - "banner": full-width banner for product detail pages
 *
 * Props:
 *   - variant: "corner" | "inline" | "banner"
 *   - condition: "used" | "refurbished" (optional, defaults to "used")
 *   - size: "sm" | "md" | "lg" (affects font/padding)
 */
export default function UsedBadge({ variant = "corner", condition = "used", size = "md" }) {
  const label = condition === "refurbished" ? "REFURB" : "USED";

  // Size tokens
  const SIZES = {
    sm: { fontSize: 9,  padV: 3, padH: 6,  radius: 4 },
    md: { fontSize: 11, padV: 4, padH: 8,  radius: 5 },
    lg: { fontSize: 13, padV: 6, padH: 12, radius: 6 },
  };
  const sz = SIZES[size] || SIZES.md;

  // Consistent branding color — amber/orange to align with the rest of the site
  const BG = "#F59E0B";    // amber-500 — prominent but not alarming
  const FG = "#1A1A20";    // dark text on amber for max contrast
  const BORDER = "#D97706"; // amber-600 for subtle depth

  if (variant === "corner") {
    return (
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          background: BG,
          color: FG,
          padding: `${sz.padV}px ${sz.padH}px`,
          borderRadius: sz.radius,
          fontFamily: "var(--mono, 'Courier New', monospace)",
          fontSize: sz.fontSize,
          fontWeight: 900,
          letterSpacing: 1.2,
          border: `1px solid ${BORDER}`,
          boxShadow: "0 2px 6px rgba(245, 158, 11, 0.4)",
          zIndex: 10,
          lineHeight: 1,
          pointerEvents: "none",
          userSelect: "none",
        }}
        aria-label={`This product is ${condition}`}
      >
        {label}
      </div>
    );
  }

  if (variant === "inline") {
    return (
      <span
        style={{
          display: "inline-block",
          background: BG,
          color: FG,
          padding: `${sz.padV}px ${sz.padH}px`,
          borderRadius: sz.radius,
          fontFamily: "var(--mono, 'Courier New', monospace)",
          fontSize: sz.fontSize,
          fontWeight: 900,
          letterSpacing: 1.2,
          border: `1px solid ${BORDER}`,
          lineHeight: 1,
          verticalAlign: "middle",
          marginLeft: 6,
        }}
        aria-label={`This product is ${condition}`}
      >
        {label}
      </span>
    );
  }

  if (variant === "banner") {
    return (
      <div
        style={{
          background: `linear-gradient(90deg, ${BG} 0%, ${BORDER} 100%)`,
          color: FG,
          padding: "10px 16px",
          borderRadius: 8,
          fontFamily: "var(--ff)",
          fontSize: 13,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          gap: 10,
          border: `1px solid ${BORDER}`,
          marginBottom: 12,
        }}
        role="alert"
      >
        <span
          style={{
            fontFamily: "var(--mono, 'Courier New', monospace)",
            fontSize: 13,
            fontWeight: 900,
            letterSpacing: 1.5,
            background: FG,
            color: BG,
            padding: "3px 8px",
            borderRadius: 4,
          }}
        >
          {label}
        </span>
        <span>
          {condition === "refurbished"
            ? "Refurbished product — tested and restored, typically with limited warranty."
            : "Used product — pre-owned condition, often cheaper but check seller rating and return policy."}
        </span>
      </div>
    );
  }

  return null;
}

/**
 * Helper: determine if a product should show a USED badge based on its data fields.
 * A product is "used" if it has: used === true OR usedOnly === true OR condition === "used"
 */
export function isUsedProduct(product) {
  if (!product) return false;
  return product.used === true || product.usedOnly === true || product.condition === "used" || product.condition === "refurbished";
}

/**
 * Helper: get condition string for the badge
 */
export function getCondition(product) {
  if (!product) return "used";
  if (product.condition === "refurbished") return "refurbished";
  return "used";
}
