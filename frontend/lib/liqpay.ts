import type { LiqPayCheckout } from "./api";

const LIQPAY_URL = "https://www.liqpay.ua/api/3/checkout";

// LiqPay expects a form POST
export function submitLiqPay({ data, signature }: LiqPayCheckout) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = LIQPAY_URL;
  form.style.display = "none";
  [
    ["data", data],
    ["signature", signature],
  ].forEach(([name, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
}
