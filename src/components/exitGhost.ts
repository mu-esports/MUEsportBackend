import { reducedMotion } from "../theme";

/**
 * อนิเมชันตอนปิดของกล่องโต้ตอบและข้อความแจ้งผล โดยไม่หน่วงการปิดจริง
 * กล่องจริงถูกปิด ถอดออกจากหน้า และคืน focus ทันทีเหมือนเดิม ส่วนที่จางออกคือ “เงา” ซึ่งเป็นสำเนาภาพของกล่อง ณ ตอนปิด
 * เงาอยู่ใน shadow root แบบปิด: กดไม่ได้ รับ focus ไม่ได้ โปรแกรมอ่านหน้าจอไม่อ่าน และไม่ปนกับองค์ประกอบจริงของหน้า
 * เรียกก่อนองค์ประกอบถูกถอดออกจากหน้า (cleanup ของ useLayoutEffect)
 */

// ยาวกว่า --motion-exit ใน src/motion.css: กันเงาค้างถ้าเบราว์เซอร์ไม่ส่ง animationend
const REMOVE_AFTER_MS = 400;

let sheet: CSSStyleSheet | null = null;
let sheetSource = -1;

/** สำเนากฎ CSS ของหน้าไว้ใช้ใน shadow root (ตัวแปรสีสืบทอดจากหน้าอยู่แล้ว) สร้างใหม่เมื่อจำนวน stylesheet ของหน้าเปลี่ยน */
function ghostStyles(): CSSStyleSheet | null {
  if (
    typeof CSSStyleSheet !== "function" ||
    !("replaceSync" in CSSStyleSheet.prototype)
  )
    return null;
  if (sheet && sheetSource === document.styleSheets.length) return sheet;
  let css = "";
  for (const source of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(source.cssRules)) {
        if (rule instanceof CSSFontFaceRule || rule instanceof CSSImportRule)
          continue;
        css += `${rule.cssText}\n`;
      }
    } catch {
      // stylesheet ต่างโดเมน: ข้าม
    }
  }
  // กฎที่ขึ้นกับธีมหรือชุดสีของหน้า (:root[data-theme='dark'] …) ให้อ้าง host ของเงาแทน
  css = css
    .replace(/:root((?:\[[^\]]+\])+)/g, ":host($1)")
    .replace(/:root(?![\w.[-])/g, ":host");
  try {
    const next = new CSSStyleSheet();
    next.replaceSync(css);
    sheet = next;
    sheetSource = document.styleSheets.length;
  } catch {
    sheet = null;
  }
  return sheet;
}

/** คัดลอกค่าที่ผู้ใช้กรอกและตำแหน่งเลื่อน (cloneNode ไม่คัดลอกให้) เพื่อให้เงาเหมือนกล่องตอนปิด */
function copyLiveState(from: HTMLElement, to: HTMLElement) {
  const source = from.querySelectorAll<HTMLElement>(
    "input, textarea, select, .dialog-body",
  );
  const target = to.querySelectorAll<HTMLElement>(
    "input, textarea, select, .dialog-body",
  );
  source.forEach((element, index) => {
    const copy = target[index];
    if (!copy) return;
    if (
      element instanceof HTMLInputElement &&
      copy instanceof HTMLInputElement
    ) {
      if (element.type === "file") return;
      copy.value = element.value;
      copy.checked = element.checked;
    } else if (
      element instanceof HTMLTextAreaElement &&
      copy instanceof HTMLTextAreaElement
    )
      copy.value = element.value;
    else if (
      element instanceof HTMLSelectElement &&
      copy instanceof HTMLSelectElement
    )
      copy.selectedIndex = element.selectedIndex;
    else copy.scrollTop = element.scrollTop;
  });
}

export function playExit(element: HTMLElement, kind: "dialog" | "toast") {
  if (reducedMotion() || !element.isConnected) return;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const styles = ghostStyles();
  if (!styles) return;

  // มีกล่อง modal อื่นเปิดอยู่ข้างใต้ (กล่องซ้อน): เงาต้องอยู่ชั้นบนสุดเหมือนกัน และฉากมืดยังเป็นของกล่องข้างใต้ จึงไม่จางฉาก
  const stacked =
    kind === "dialog" &&
    Array.from(document.querySelectorAll("dialog[open]")).some(
      (other) => other !== element,
    );

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  const root = document.documentElement;
  if (root.dataset.theme) host.dataset.theme = root.dataset.theme;
  if (root.dataset.surface) host.dataset.surface = root.dataset.surface;
  host.style.cssText =
    "position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;background:transparent;overflow:hidden;pointer-events:none;z-index:2147483646;";

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.adoptedStyleSheets = [styles];

  if (kind === "dialog" && !stacked) {
    const backdrop = document.createElement("div");
    backdrop.className = "exit-ghost-backdrop";
    shadow.append(backdrop);
  }

  const ghost = element.cloneNode(true) as HTMLElement;
  ghost.classList.add(kind === "dialog" ? "exit-ghost" : "exit-ghost-toast");
  if (kind === "dialog") ghost.setAttribute("open", "");
  ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;right:auto;bottom:auto;width:${rect.width}px;height:${rect.height}px;max-width:none;max-height:none;margin:0;pointer-events:none;`;
  shadow.append(ghost);
  copyLiveState(element, ghost);

  // รอให้ React ถอดองค์ประกอบจริงออกก่อน: ถ้ายังอยู่ในหน้า แปลว่าไม่ได้ปิดจริง (เช่น การตรวจซ้ำของโหมดพัฒนา) ไม่ต้องแสดงเงา
  queueMicrotask(() => {
    if (element.isConnected) return;
    document.body.append(host);
    if (stacked && typeof host.showPopover === "function") {
      host.popover = "manual";
      try {
        host.showPopover();
      } catch {
        // แสดงในชั้นบนสุดไม่ได้: เงาอยู่ใต้กล่องที่ยังเปิด ซึ่งไม่กระทบการใช้งาน
      }
    }
    const remove = () => host.remove();
    ghost.addEventListener("animationend", remove, { once: true });
    setTimeout(remove, REMOVE_AFTER_MS);
  });
}
