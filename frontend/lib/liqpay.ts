import { api } from "./api";

const LIQPAY_URL = "https://www.liqpay.ua/api/3/checkout";
export const PRICE_UAH = 700;

// Returns false when no redirect happened (booking turned out to be already paid)
export async function redirectToLiqPay(slotId: string): Promise<boolean> {
  const checkout = await api.createCheckout(slotId);
  if ("status" in checkout) return false;
  const { data, signature } = checkout;
  const form = document.createElement("form");
  form.method = "POST";
  form.action = LIQPAY_URL;
  form.style.display = "none";
  [["data", data], ["signature", signature]].forEach(([name, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
  return true;
}
