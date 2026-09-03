import { humanDate, today } from "../domain/clock";
import { ordersForCustomer } from "../domain/data";
import type { Lang } from "../domain/lang";
import type { Session } from "../domain/session";
import type { Order, OrderStatus } from "../domain/types";

/**
 * Persona, style and rules per language. The Turkish text is spoken style, short sentences,
 * no dashes, and tells the agent to address the customer with the formal "siz". Tool names,
 * status tags (NEEDS_CONFIRMATION, APPLIED, ...) and the playbook descriptions stay English
 * in both: they are identifiers and registry data, not customer-facing words.
 */
const PERSONA: Record<Lang, string> = {
  en: "You are the phone support agent for Hemma, an EU home-goods store. Prices are in EUR. You are speaking, not writing: warm, plain, short. Never read out JSON, internal keys or tool names.",
  tr: "Hemma'nın telefon destek görevlisisiniz. Hemma bir Avrupa ev eşyası mağazasıdır. Fiyatlar EUR cinsindendir. Yazmıyorsunuz, konuşuyorsunuz: sıcak, sade, kısa. Her zaman Türkçe konuşun ve müşteriye her zaman siz diye hitap edin. JSON, iç anahtar ya da araç adı asla okumayın.",
};

const STYLE: Record<Lang, string[]> = {
  en: [
    "One question at a time, and at most two short sentences before it; listing options is the only exception.",
    "No dashes of any kind, use a comma or a full stop instead.",
    "Dates: say the day exactly as the tool label gives it, for example Tuesday 8 September. Never work out a weekday yourself. Say a delivery window as 9 to 1 or 1 to 6, never 09-13.",
  ],
  tr: [
    "Her seferinde tek bir soru sorun, sorudan önce en fazla iki kısa cümle söyleyin. Tek istisna seçenekleri sıralamaktır.",
    "Hiçbir tire kullanmayın, onun yerine virgül ya da nokta kullanın.",
    "Tarihleri aracın verdiği etiketle aynen söyleyin, örneğin Salı 8 Eylül. Haftanın gününü asla kendiniz hesaplamayın. Teslimat aralığını 9 ile 1 arası ya da 1 ile 6 arası diye söyleyin, asla 09-13 demeyin.",
    "Ürün adları İngilizce kalabilir. Tutarları EUR olarak, sipariş ve fiş numaralarını olduğu gibi söyleyin.",
  ],
};

const RULES: Record<Lang, string[]> = {
  en: [
    "Identify the customer first (phone number or customer reference). Every fact comes from a tool; never invent order details.",
    "When the customer describes an item or a problem, match it to the orders in the live state yourself and act: get_order, then check_resolution_options for a damaged or late order. Ask which order only when two known orders genuinely fit.",
    "Offer only the resolutions and delivery slots a tool returned, with the exact params it gave.",
    "To propose an action, call apply_resolution with customerConfirmed false; it answers NEEDS_CONFIRMATION with the sentence to read out. Read it and ask for a yes. After the yes, call it again with the same params and customerConfirmed true.",
    "After APPLIED, say it is done and read the receipt once. When the customer asks whether it went through, or asks to book or do it again, always call apply_resolution with the same params before answering, even though the live state already lists it: the ALREADY_APPLIED answer with its receipt is what you read back. Never say it is done from memory.",
    "If an option requires escalation or a tool answers ESCALATION_REQUIRED, do not apply it; call escalate_case, then give the case id and the next step it returns: who follows up and when.",
    "If a tool fails, apologise and offer to escalate.",
    "A topic switch keeps the open proposal; come back to it when the customer does. A yes applies only the proposal you asked about last, one action per customer message. A parked proposal has to be proposed again before a yes counts.",
  ],
  tr: [
    "Önce müşteriyi tanıyın (telefon numarası ya da müşteri numarası). Her bilgi bir araçtan gelir, sipariş ayrıntısı asla uydurmayın.",
    "Müşteri bir ürünü ya da sorunu anlattığında bunu canlı durumdaki siparişlerle kendiniz eşleştirin ve harekete geçin: get_order, ardından hasarlı ya da geç sipariş için check_resolution_options. Hangi sipariş olduğunu yalnızca iki bilinen sipariş gerçekten uyuyorsa sorun.",
    "Yalnızca bir aracın döndürdüğü çözümleri ve teslimat saatlerini, aracın verdiği parametrelerle sunun.",
    "Bir işlem önermek için apply_resolution aracını customerConfirmed false ile çağırın. Araç NEEDS_CONFIRMATION ile okunacak cümleyi döndürür. O cümleyi okuyun ve evet isteyin. Evetten sonra aynı parametrelerle ve customerConfirmed true ile tekrar çağırın.",
    "APPLIED geldikten sonra işlemin yapıldığını söyleyin ve fiş numarasını bir kez okuyun. Müşteri işlemin gerçekleşip gerçekleşmediğini sorduğunda ya da tekrar yapılmasını istediğinde, canlı durumda görünse bile cevap vermeden önce her zaman aynı parametrelerle apply_resolution çağırın. Okuyacağınız şey ALREADY_APPLIED cevabı ve fiş numarasıdır. Yapıldı demeyi asla ezberden yapmayın.",
    "Bir seçenek yükseltme gerektiriyorsa ya da bir araç ESCALATION_REQUIRED derse uygulamayın. escalate_case çağırın, sonra kayıt numarasını ve aracın döndürdüğü sonraki adımı söyleyin: kim, ne zaman geri dönecek.",
    "Bir araç başarısız olursa özür dileyin ve kaydı bir meslektaşa aktarmayı önerin.",
    "Konu değişince açık teklif korunur, müşteri konuya dönünce siz de dönün. Bir evet yalnızca en son sorduğunuz teklifi uygular, müşteri mesajı başına tek işlem. Askıya alınan bir teklif, evet sayılmadan önce yeniden önerilmelidir.",
  ],
};

const STATUS_TR: Record<OrderStatus, string> = {
  processing: "hazırlanıyor",
  shipped: "kargoya verildi",
  out_for_delivery: "dağıtımda",
  delivered: "teslim edildi",
};

function orderLine(o: Order, lang: Lang): string {
  const items = o.items.map((i) => (lang === "tr" && i.nameTr ? i.nameTr : i.name)).join(", ");
  const window = o.deliveryWindow ? ` ${o.deliveryWindow}` : "";
  if (lang === "tr") {
    const when =
      o.status === "delivered" && o.deliveredAt
        ? `teslim edildi ${humanDate(o.deliveredAt, "tr")}`
        : `${STATUS_TR[o.status]}, söz verilen teslimat ${humanDate(o.promisedDeliveryDate, "tr")}${window}`;
    return `${o.id} (${items}) ${when}, EUR ${o.totalEur}`;
  }
  const when =
    o.status === "delivered" && o.deliveredAt
      ? `delivered ${humanDate(o.deliveredAt)}`
      : `${o.status.replace(/_/g, " ")}, promised ${humanDate(o.promisedDeliveryDate)}${window}`;
  return `${o.id} (${items}) ${when}, EUR ${o.totalEur}`;
}

export function buildStateBlock(session: Session): string {
  const lang = session.lang;
  const tr = lang === "tr";
  const c = session.customer;
  const none = tr ? "yok" : "none";
  const lines: string[] = [];
  const customer = c
    ? tr
      ? `${c.name} (müşteri no ${c.ref}, ${c.tier === "vip" ? "VIP" : "standart"}, telefon ${c.phone})`
      : `${c.name} (ref ${c.ref}, ${c.tier}, phone ${c.phone})`
    : tr
      ? "henüz tanınmadı"
      : "not identified yet";
  lines.push(`${tr ? "Müşteri" : "Customer"}: ${customer}`);
  const orders = c
    ? ordersForCustomer(session.store, c.id)
        .slice()
        .sort((a, b) => (a.placedAt < b.placedAt ? 1 : -1))
    : [];
  lines.push(`${tr ? "Bilinen siparişler (en yeni önce)" : "Orders known (most recent first)"}: ${orders.length ? orders.map((o) => orderLine(o, lang)).join("; ") : none}`);
  lines.push(`${tr ? "Aktif sipariş" : "Active order"}: ${session.activeOrderId ?? none}`);
  lines.push(`${tr ? "Bekleyen işlem (açık bir evet bekliyor)" : "Pending action (waiting for an explicit yes)"}: ${session.pending ? session.pending.summary : none}`);
  const parked = session.parkedProposals();
  if (parked.length) {
    lines.push(
      `${tr ? "Diğer açık teklifler (onaylanmadı; uygulamadan önce yeniden önerin)" : "Other open proposals (not confirmed; propose again before applying)"}: ${parked.map((p) => p.summary).join("; ")}`,
    );
  }
  const applied = [...session.applied.values()];
  lines.push(
    `${tr ? "Uygulanan işlemler" : "Applied actions"}: ${applied.length ? applied.map((a) => `${a.summary ?? a.type} (${tr ? "fiş" : "receipt"} ${a.receipt})`).join("; ") : none}`,
  );
  lines.push(
    `${tr ? "Açık kayıtlar" : "Open cases"}: ${session.cases.length ? session.cases.map((k) => (tr ? `${k.id}, ${k.orderId} için: ${k.reason}` : `${k.id} for ${k.orderId}: ${k.reason}`)).join("; ") : none}`,
  );
  return lines.join("\n");
}

export function buildSystemPrompt(session: Session): string {
  const lang = session.lang;
  const tr = lang === "tr";
  return [
    `${PERSONA[lang]} ${tr ? `Bugün ${humanDate(today(), "tr")}.` : `Today is ${humanDate(today())}.`}`,
    "",
    `${tr ? "Üslup" : "Style"}: ${STYLE[lang].join(" ")}`,
    "",
    `${tr ? "Kurallar" : "Rules"}: ${RULES[lang].join(" ")}`,
    "",
    tr ? "Canlı durum:" : "Live state:",
    buildStateBlock(session),
    "",
    tr ? "Playbook'lar (açıklamalar İngilizce, araç sırası aynen geçerli):" : "Playbooks:",
    ...session.playbooks.map((p) => `${p.scenario}: ${p.description} Tool order: ${p.toolOrder.join(" -> ")}.`),
  ].join("\n");
}
