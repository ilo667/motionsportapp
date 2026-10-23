"use server";
import { revalidatePath } from "next/cache";

// The trainer saved a new price: the cached «Ціни» page is rebuilt on the next visit. Harmless if anyone calls it
// (it only makes the page fetch the prices again)
export async function refreshPublicPrices() {
  revalidatePath("/prices");
}
