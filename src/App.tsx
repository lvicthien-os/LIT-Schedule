import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutDashboard,
  CalendarClock,
  Users,
  Wallet,
  Settings,
  Plus,
  Download,
  Upload,
  AlertTriangle,
  Search,
  Trash2,
  Pencil,
  Check,
  X,
  ChevronLeft,
  ChevronRight,
  List,
  CalendarDays,
  CalendarRange,
  Receipt,
  RefreshCw,
  LogOut,
  FileSpreadsheet,
} from "lucide-react";

declare global {
  interface Window {
    litDesktop?: {
      readLocalFile: () => Promise<{
        ok: boolean;
        filePath: string;
        data: Partial<DrivePayload> | null;
        error?: string;
      }>;
      writeLocalFile: (payload: DrivePayload) => Promise<{
        ok: boolean;
        filePath: string;
        error?: string;
      }>;
    };
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            hint?: string;
            callback: (resp: { access_token?: string; expires_in?: number; error?: string }) => void;
          }) => { requestAccessToken: (opts?: { prompt?: string; hint?: string }) => void };
        };
      };
    };
  }
}

type WorkStatus = "Chờ xác nhận" | "Đã xác nhận" | "Đang thực hiện" | "Hoàn thành" | "Đã hủy";
type PaymentStatus = "Chưa thanh toán" | "Đã đặt cọc" | "Thanh toán một phần" | "Đã thanh toán đủ";
type TabKey = "dashboard" | "appointments" | "customers" | "finance" | "bulk" | "settings";
type CalendarViewMode = "list" | "week" | "month";
type ExpenseCategory = "Thu" | "Tiền vật tư" | "Chi phí công thợ" | "Khác";

interface Installment {
  id: string;
  amount: number;
  paidAt: string;
  note: string;
}

interface Appointment {
  id: string;
  serviceContent: string;
  customerName: string;
  customerPhone: string;
  location: string;
  serviceDate: string;
  startTime: string;
  endTime: string;
  notes: string;
  totalServiceAmount: number;
  depositAmount: number;
  materialCost?: number;
  laborCost?: number;
  installments: Installment[];
  workStatus: WorkStatus;
  paymentStatus: PaymentStatus;
}

interface BoothExpense {
  id: string;
  date: string;
  category: ExpenseCategory;
  title: string;
  amount: number;
  appointmentId?: string;
  note: string;
}

interface DrivePayload {
  updatedAt: string;
  appointments: Appointment[];
  expenses: BoothExpense[];
}

interface SavedDriveAuth {
  accessToken: string;
  expiresAt: number;
  email: string;
  autoSyncEnabled: boolean;
}

const DEFAULT_CLIENT_ID = "943505698857-74q70ulunhj9mhckn3dvdud9sdqfvste.apps.googleusercontent.com";
const CLIENT_ID_STORAGE = "lit_schedule_gdrive_client_id_v1";
const AUTH_STORAGE = "lit_schedule_gdrive_auth_v1";
const APPOINTMENTS_KEY = "lit_schedule_gdrive_appts_v1";
const EXPENSES_KEY = "lit_schedule_gdrive_exps_v1";
const DRIVE_FILE_NAME = "LITSchedule_data.json";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
const WEEKDAYS_VI = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

function formatCommaNumber(num: number): string {
  const safe = Math.max(0, Math.round(num || 0));
  return safe.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function handleThousandInputChange(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return "";
  const amount = Number(digits);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return formatCommaNumber(amount);
}

function parseMoneyInput(val: string | number | undefined): number {
  if (typeof val === "number") return Number.isFinite(val) ? Math.max(0, Math.round(val)) : 0;
  if (!val) return 0;
  const digits = val.replace(/[^0-9]/g, "");
  if (!digits) return 0;
  const num = Number(digits);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
}

function formatVND(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return sign + formatCommaNumber(Math.abs(Math.round(amount))) + " ₫";
}

function normalizeBulkDate(rawDate: string): string {
  const s = rawDate.trim();
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  }
  return new Date().toISOString().slice(0, 10);
}

function normalizeTimeToken(rawTime: string): string {
  const m = rawTime.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "09:00";
  const hh = String(Math.min(23, Math.max(0, Number(m[1])))).padStart(2, "0");
  const mm = String(Math.min(59, Math.max(0, Number(m[2])))).padStart(2, "0");
  return `${hh}:${mm}`;
}

function parseBulkLine(line: string): {
  ok: boolean;
  error?: string;
  data?: {
    serviceContent: string;
    customerName: string;
    serviceDate: string;
    startTime: string;
    endTime: string;
    totalServiceAmount: number;
    depositAmount: number;
    location: string;
    notes: string;
  };
} {
  const trimmed = line.trim();
  if (!trimmed) return { ok: false };

  let parts: string[] = [];
  if (trimmed.includes("|")) {
    parts = trimmed.split("|").map((p) => p.trim());
  } else {
    const protectedTime = trimmed.replace(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g, "$1__TO__$2");
    parts = protectedTime.split(/\s+-\s+|\s+-|-\s+/).map((p) => p.replace(/__TO__/g, "-").trim());
  }

  if (parts.length < 2) {
    return { ok: false, error: `Thiếu thông tin: "${trimmed}"` };
  }

  const serviceContent = parts[0] || "Photobooth";
  const customerName = parts[1] || "";
  if (!customerName) {
    return { ok: false, error: `Thiếu tên khách hàng: "${trimmed}"` };
  }

  let serviceDate = new Date().toISOString().slice(0, 10);
  let startTime = "09:00";
  let endTime = "11:00";
  let totalServiceAmount = 0;
  let depositAmount = 500000;
  const extraParts: string[] = [];

  for (let i = 2; i < parts.length; i++) {
    const token = parts[i];
    if (!token) continue;

    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(token) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(token)) {
      serviceDate = normalizeBulkDate(token);
      continue;
    }

    const timeMatch = token.match(/^(\d{1,2}:\d{2})\s*(?:-|–|to|đến)\s*(\d{1,2}:\d{2})$/i);
    if (timeMatch) {
      startTime = normalizeTimeToken(timeMatch[1]);
      endTime = normalizeTimeToken(timeMatch[2]);
      continue;
    }

    const moneyCandidate = token.replace(/[^0-9]/g, "");
    const looksLikeMoney = moneyCandidate.length >= 4 && token.replace(/[0-9,\.\s₫đvnVNĐ]/g, "").length === 0;
    if (looksLikeMoney) {
      const val = parseMoneyInput(token);
      if (totalServiceAmount === 0) {
        totalServiceAmount = val;
      } else {
        depositAmount = val;
      }
      continue;
    }

    extraParts.push(token);
  }

  const combinedNote = extraParts.join(" - ").trim();
  const location = combinedNote || "Đà Nẵng";

  return {
    ok: true,
    data: {
      serviceContent,
      customerName,
      serviceDate,
      startTime,
      endTime,
      totalServiceAmount,
      depositAmount,
      location,
      notes: combinedNote,
    },
  };
}

function getPaidAmount(a: Appointment): number {
  const extra = a.installments.reduce((sum, item) => sum + item.amount, 0);
  return Math.max(a.depositAmount, a.depositAmount + extra);
}

function getRemainingAmount(a: Appointment): number {
  return Math.max(0, a.totalServiceAmount - getPaidAmount(a));
}

function getAppointmentBoothCost(a: Appointment): number {
  return Math.max(0, (a.materialCost || 0) + (a.laborCost || 0));
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);

  return (h || 0) * 60 + (m || 0);
}

function formatDateDMY(dateKey: string): string {
  const raw = String(dateKey || "").trim();
  const mIso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (mIso) {
    return `${mIso[3].padStart(2, "0")}/${mIso[2].padStart(2, "0")}/${mIso[1]}`;
  }
  const mDmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mDmy) {
    return `${mDmy[1].padStart(2, "0")}/${mDmy[2].padStart(2, "0")}/${mDmy[3]}`;
  }
  return raw;
}

function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDateKey(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y || 2026, (m || 1) - 1, d || 1);
}

function getMondayOfWeek(d: Date): Date {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  return copy;
}

function syncPaymentStatus(appt: Appointment): PaymentStatus {
  const rem = getRemainingAmount(appt);
  if (rem <= 0 && appt.totalServiceAmount > 0) return "Đã thanh toán đủ";
  if (getPaidAmount(appt) > 0) {
    return appt.installments.length > 0 ? "Thanh toán một phần" : "Đã đặt cọc";
  }
  return "Chưa thanh toán";
}

function loadSavedAuth(): SavedDriveAuth | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE);
    if (!raw) return null;
    return JSON.parse(raw) as SavedDriveAuth;
  } catch {
    return null;
  }
}

function saveAuthToStorage(auth: SavedDriveAuth | null) {
  try {
    if (!auth) {
      localStorage.removeItem(AUTH_STORAGE);
    } else {
      localStorage.setItem(AUTH_STORAGE, JSON.stringify(auth));
    }
  } catch {
    // bỏ qua
  }
}

async function fetchGoogleUserEmail(token: string): Promise<string> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { email?: string };
    return data.email || "";
  } catch {
    return "";
  }
}

async function findDriveFileId(token: string): Promise<string | null> {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error("Không truy vấn được danh sách file trên Google Drive");
  const data = (await res.json()) as { files?: Array<{ id: string }> };
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

async function downloadDrivePayload(token: string): Promise<DrivePayload | null> {
  const fileId = await findDriveFileId(token);
  if (!fileId) return null;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error("Không tải được nội dung file từ Google Drive");

  return (await res.json()) as DrivePayload;
}

async function uploadDrivePayload(token: string, payload: DrivePayload): Promise<void> {
  const fileId = await findDriveFileId(token);
  const bodyText = JSON.stringify(payload, null, 2);

  if (fileId) {
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: bodyText,
    });
    if (res.status === 401) throw new Error("TOKEN_EXPIRED");
    if (!res.ok) throw new Error("Không cập nhật được file lên Google Drive");
  } else {
    const boundary = "lit_schedule_boundary_" + Date.now();
    const metadata = JSON.stringify({
      name: DRIVE_FILE_NAME,
      mimeType: "application/json",
    });
    const multipartBody =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${bodyText}\r\n` +
      `--${boundary}--`;

    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    });
    if (res.status === 401) throw new Error("TOKEN_EXPIRED");
    if (!res.ok) throw new Error("Không tạo mới được file trên Google Drive");
  }
}


function getVietnameseLunarInfo(dateObj: Date): {
  lunarDay: number;
  lunarMonth: number;
  lunarYear: number;
  isLeap: boolean;
  label: string;
  isSpecialDay: boolean;
} {
  const jdFromDate = (dd: number, mm: number, yy: number): number => {
    const a = Math.floor((14 - mm) / 12);
    const y = yy + 4800 - a;
    const m = mm + 12 * a - 3;
    let jd =
      dd +
      Math.floor((153 * m + 2) / 5) +
      365 * y +
      Math.floor(y / 4) -
      Math.floor(y / 100) +
      Math.floor(y / 400) -
      32045;
    if (jd < 2299161) {
      jd = dd + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
    }
    return jd;
  };

  const getNewMoonDay = (k: number, timeZone = 7): number => {
    const T = k / 1236.85;
    const T2 = T * T;
    const T3 = T2 * T;
    const dr = Math.PI / 180;
    let Jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
    Jd1 += 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr);
    const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3;
    const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3;
    const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3;
    let C1 =
      (0.1734 - 0.000393 * T) * Math.sin(M * dr) +
      0.0021 * Math.sin(2 * M * dr) -
      0.4068 * Math.sin(Mpr * dr) +
      0.0161 * Math.sin(2 * Mpr * dr) -
      0.0004 * Math.sin(3 * Mpr * dr) +
      0.0104 * Math.sin(2 * F * dr) -
      0.0051 * Math.sin((M + Mpr) * dr) -
      0.0074 * Math.sin((M - Mpr) * dr) +
      0.0004 * Math.sin((2 * F + M) * dr) -
      0.0004 * Math.sin((2 * F - M) * dr) -
      0.0006 * Math.sin((2 * F + Mpr) * dr) +
      0.001 * Math.sin((2 * F - Mpr) * dr) +
      0.0005 * Math.sin((M + 2 * Mpr) * dr);
    let deltat: number;
    if (T < -11) {
      deltat = 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3;
    } else {
      deltat = -0.000278 + 0.000265 * T + 0.000262 * T2;
    }
    return Math.floor(Jd1 + C1 - deltat + 0.5 + timeZone / 24);
  };

  const getSunLongitude = (jdn: number, timeZone = 7): number => {
    const T = (jdn - 2451545.0 - timeZone / 24) / 36525;
    const T2 = T * T;
    const dr = Math.PI / 180;
    const M = 357.5291 + 35999.0503 * T - 0.0001559 * T2 - 0.00000048 * T * T2;
    const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2;
    let DL =
      (1.9146 - 0.004817 * T - 0.000014 * T2) * Math.sin(M * dr) +
      (0.019993 - 0.000101 * T) * Math.sin(2 * M * dr) +
      0.00029 * Math.sin(3 * M * dr);
    let L = (L0 + DL) * dr;
    L = L - Math.PI * 2 * Math.floor(L / (Math.PI * 2));
    return Math.floor((L / Math.PI) * 6);
  };

  const getLunarMonth11 = (yy: number, timeZone = 7): number => {
    const off = jdFromDate(31, 12, yy) - 2415021;
    const k = Math.floor(off / 29.530588853);
    let nm = getNewMoonDay(k, timeZone);
    if (getSunLongitude(nm, timeZone) >= 9) {
      nm = getNewMoonDay(k - 1, timeZone);
    }
    return nm;
  };

  const getLeapMonthOffset = (a11: number, timeZone = 7): number => {
    const k = Math.floor((a11 - 2415021.076998695) / 29.530588853 + 0.5);
    let last = 0;
    let i = 1;
    let arc = getSunLongitude(getNewMoonDay(k + i, timeZone), timeZone);
    do {
      last = arc;
      i++;
      arc = getSunLongitude(getNewMoonDay(k + i, timeZone), timeZone);
    } while (arc !== last && i < 14);
    return i - 1;
  };

  const dd = dateObj.getDate();
  const mm = dateObj.getMonth() + 1;
  const yy = dateObj.getFullYear();
  const timeZone = 7;
  const dayNumber = jdFromDate(dd, mm, yy);
  const k = Math.floor((dayNumber - 2415021.076998695) / 29.530588853);
  let monthStart = getNewMoonDay(k + 1, timeZone);
  if (monthStart > dayNumber) {
    monthStart = getNewMoonDay(k, timeZone);
  }
  let a11 = getLunarMonth11(yy, timeZone);
  let b11 = a11;
  let lunarYear: number;
  if (a11 >= monthStart) {
    lunarYear = yy;
    a11 = getLunarMonth11(yy - 1, timeZone);
  } else {
    lunarYear = yy + 1;
    b11 = getLunarMonth11(yy + 1, timeZone);
  }
  const lunarDay = dayNumber - monthStart + 1;
  const diff = Math.floor((monthStart - a11) / 29);
  let isLeap = false;
  let lunarMonth = diff + 11;
  if (b11 - a11 > 365) {
    const leapMonthDiff = getLeapMonthOffset(a11, timeZone);
    if (diff >= leapMonthDiff) {
      lunarMonth = diff + 10;
      if (diff === leapMonthDiff) {
        isLeap = true;
      }
    }
  }
  if (lunarMonth > 12) lunarMonth -= 12;
  if (lunarMonth >= 11 && diff < 4) lunarYear -= 1;

  const isSpecialDay = lunarDay === 1 || lunarDay === 15;
  const label =
    lunarDay === 1
      ? `Mùng 1/${lunarMonth}${isLeap ? "N" : ""}`
      : `${lunarDay}/${lunarMonth}${isLeap ? "N" : ""}`;

  return { lunarDay, lunarMonth, lunarYear, isLeap, label, isSpecialDay };
}

export function App() {
  const [clientId, setClientId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(CLIENT_ID_STORAGE);
      if (saved) return saved;
    } catch {
      // bỏ qua
    }
    return DEFAULT_CLIENT_ID;
  });
  const [clientIdInput, setClientIdInput] = useState<string>(clientId);

  const initialAuth = useMemo(() => loadSavedAuth(), []);
  const [savedAuth, setSavedAuth] = useState<SavedDriveAuth | null>(initialAuth);
  const [driveStatus, setDriveStatus] = useState<string>(() => {
    if (initialAuth?.autoSyncEnabled) {
      return `Tự động đồng bộ Drive${initialAuth.email ? ` (${initialAuth.email})` : ""}`;
    }
    return "Chưa kết nối Google Drive (đang dùng bản lưu máy)";
  });
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [desktopFilePath, setDesktopFilePath] = useState<string>("");

  const [activeTab, setActiveTab] = useState<TabKey>("dashboard");
  const [calendarView, setCalendarView] = useState<CalendarViewMode>("month");
  const [cursorDate, setCursorDate] = useState<Date>(() => new Date());
  const [selectedDateKey, setSelectedDateKey] = useState<string>(() => toDateKey(new Date()));

  const [appointments, setAppointments] = useState<Appointment[]>(() => {
    try {
      const raw = localStorage.getItem(APPOINTMENTS_KEY);
      if (raw) return JSON.parse(raw) as Appointment[];
    } catch {
      // bỏ qua
    }
    return [];
  });

  const [expenses, setExpenses] = useState<BoothExpense[]>(() => {
    try {
      const raw = localStorage.getItem(EXPENSES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as BoothExpense[];
        return parsed.map((e) => ({
          ...e,
          category: (e.category as string) === "Nhân công" ? "Chi phí công thợ" : e.category,
        }));
      }
    } catch {
      // bỏ qua
    }
    return [];
  });

  const latestDataRef = useRef<{ appointments: Appointment[]; expenses: BoothExpense[] }>({
    appointments,
    expenses,
  });
  latestDataRef.current = { appointments, expenses };

  const [bulkText, setBulkText] = useState<string>("");
  const [bulkFeedback, setBulkFeedback] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [selectedCustomerKey, setSelectedCustomerKey] = useState<string | null>(null);
  const [conflictAlert, setConflictAlert] = useState<string | null>(null);
  const [payAmountInput, setPayAmountInput] = useState<Record<string, string>>({});

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    serviceContent: string;
    customerName: string;
    customerPhone: string;
    location: string;
    serviceDate: string;
    startTime: string;
    endTime: string;
    totalServiceAmount: string;
    depositAmount: string;
    materialCost: string;
    laborCost: string;
    notes: string;
  } | null>(null);

  const [editingCustomerKey, setEditingCustomerKey] = useState<string | null>(null);
  const [customerEditName, setCustomerEditName] = useState("");
  const [customerEditPhone, setCustomerEditPhone] = useState("");

  const [serviceContent, setServiceContent] = useState("Photobooth");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [location, setLocation] = useState("Đà Nẵng");
  const [serviceDate, setServiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("11:00");
  const [totalAmount, setTotalAmount] = useState("");
  const [depositAmount, setDepositAmount] = useState("500,000");
  const [laborCost, setLaborCost] = useState("");
  const [notes, setNotes] = useState("");

  const [incDate, setIncDate] = useState(new Date().toISOString().slice(0, 10));
  const [incTitle, setIncTitle] = useState("");
  const [incAmount, setIncAmount] = useState("");
  const [incAppointmentId, setIncAppointmentId] = useState("");
  const [incNote, setIncNote] = useState("");

  const [expDate, setExpDate] = useState(new Date().toISOString().slice(0, 10));
  const [expCategory, setExpCategory] = useState<ExpenseCategory>("Tiền vật tư");
  const [expTitle, setExpTitle] = useState("");
  const [expAmount, setExpAmount] = useState("");
  const [expAppointmentId, setExpAppointmentId] = useState("");
  const [expNote, setExpNote] = useState("");
  const [expSearchText, setExpSearchText] = useState("");
  const [expFilterCategory, setExpFilterCategory] = useState<"Tất cả" | "Thu" | "Tiền vật tư" | "Chi phí công thợ" | "Khác">("Tất cả");

  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [editExpForm, setEditExpForm] = useState<{
    date: string;
    category: ExpenseCategory;
    title: string;
    amount: string;
    appointmentId: string;
    note: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!window.litDesktop) return;
      const res = await window.litDesktop.readLocalFile();
      if (!active || !res.ok) return;
      setDesktopFilePath(res.filePath);
      if (res.data) {
        const fileAppts = Array.isArray(res.data.appointments) ? res.data.appointments : [];
        const fileExps = Array.isArray(res.data.expenses)
          ? res.data.expenses.map((e) => ({
              ...e,
              category: (e.category as string) === "Nhân công" ? ("Chi phí công thợ" as ExpenseCategory) : e.category,
            }))
          : [];
        if (fileAppts.length > 0 || fileExps.length > 0) {
          setAppointments(fileAppts);
          setExpenses(fileExps);
          setDriveStatus("Đã tải dữ liệu từ file: " + res.filePath);
        }
      }
    })();


  return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(APPOINTMENTS_KEY, JSON.stringify(appointments));
    } catch {
      // bỏ qua
    }
    if (window.litDesktop) {
      window.litDesktop
        .writeLocalFile({
          updatedAt: new Date().toISOString(),
          appointments,
          expenses: latestDataRef.current.expenses,
        })
        .then((r) => {
          if (r.ok) setDesktopFilePath(r.filePath);
        });
    }
  }, [appointments]);

  useEffect(() => {
    try {
      localStorage.setItem(EXPENSES_KEY, JSON.stringify(expenses));
    } catch {
      // bỏ qua
    }
    if (window.litDesktop) {
      window.litDesktop
        .writeLocalFile({
          updatedAt: new Date().toISOString(),
          appointments: latestDataRef.current.appointments,
          expenses,
        })
        .then((r) => {
          if (r.ok) setDesktopFilePath(r.filePath);
        });
    }
  }, [expenses]);

  useEffect(() => {
    try {
      if (clientId) localStorage.setItem(CLIENT_ID_STORAGE, clientId);
    } catch {
      // bỏ qua
    }
  }, [clientId]);

  function requestFreshToken(options?: { interactive?: boolean; emailHint?: string }): Promise<string | null> {
    const activeClientId = (clientIdInput || clientId).trim();
    if (!activeClientId || !window.google?.accounts?.oauth2) {
      return Promise.resolve(null);
    }
    const interactive = options?.interactive ?? false;
    const hint = options?.emailHint ?? savedAuth?.email ?? "";

    return new Promise((resolve) => {
      try {
        const tokenClient = window.google!.accounts.oauth2.initTokenClient({
          client_id: activeClientId,
          scope: DRIVE_SCOPE,
          hint: hint || undefined,
          callback: async (resp) => {
            if (resp.error || !resp.access_token) {
              resolve(null);
              return;
            }
            const expiresInSec = resp.expires_in && resp.expires_in > 0 ? resp.expires_in : 3500;
            const email = hint || (await fetchGoogleUserEmail(resp.access_token));
            const nextAuth: SavedDriveAuth = {
              accessToken: resp.access_token,
              expiresAt: Date.now() + (expiresInSec - 60) * 1000,
              email,
              autoSyncEnabled: true,
            };
            setSavedAuth(nextAuth);
            saveAuthToStorage(nextAuth);
            resolve(resp.access_token);
          },
        });
        tokenClient.requestAccessToken({
          prompt: interactive ? "select_account" : "",
          hint: hint || undefined,
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function ensureValidDriveToken(allowInteractiveFallback = false): Promise<string | null> {
    if (savedAuth && savedAuth.accessToken && Date.now() < savedAuth.expiresAt) {
      return savedAuth.accessToken;
    }
    if (savedAuth?.autoSyncEnabled) {
      const silentToken = await requestFreshToken({ interactive: false, emailHint: savedAuth.email });
      if (silentToken) return silentToken;
    }
    if (allowInteractiveFallback) {
      return await requestFreshToken({ interactive: true, emailHint: savedAuth?.email });
    }
    return null;
  }

  async function pushToDrive(token: string, nextAppts: Appointment[], nextExps: BoothExpense[], emailLabel?: string) {
    setIsSyncing(true);
    const label = emailLabel || savedAuth?.email || "";
    try {
      await uploadDrivePayload(token, {
        updatedAt: new Date().toISOString(),
        appointments: nextAppts,
        expenses: nextExps,
      });
      setDriveStatus(`Đã đồng bộ Google Drive${label ? ` (${label})` : ""} • ${DRIVE_FILE_NAME}`);
    } catch (err) {
      if (err instanceof Error && err.message === "TOKEN_EXPIRED") {
        const refreshed = await requestFreshToken({ interactive: false, emailHint: label });
        if (refreshed) {
          await uploadDrivePayload(refreshed, {
            updatedAt: new Date().toISOString(),
            appointments: nextAppts,
            expenses: nextExps,
          });
          setDriveStatus(`Đã đồng bộ Google Drive${label ? ` (${label})` : ""} • ${DRIVE_FILE_NAME}`);
          return;
        }
      }
      setDriveStatus(err instanceof Error ? err.message : "Lỗi đồng bộ Google Drive");
    } finally {
      setIsSyncing(false);
    }
  }

  async function pullAndMergeFromDrive(token: string, emailLabel?: string) {
    setIsSyncing(true);
    const label = emailLabel || savedAuth?.email || "";
    try {
      const remote = await downloadDrivePayload(token);
      if (remote) {
        const remAppts = Array.isArray(remote.appointments) ? remote.appointments : [];
        const remExps = Array.isArray(remote.expenses)
          ? remote.expenses.map((e) => ({
              ...e,
              category: (e.category as string) === "Nhân công" ? ("Chi phí công thợ" as ExpenseCategory) : e.category,
            }))
          : [];
        setAppointments(remAppts);
        setExpenses(remExps);
        setDriveStatus(`Đã đồng bộ từ Google Drive${label ? ` (${label})` : ""} • ${DRIVE_FILE_NAME}`);
      } else {
        await uploadDrivePayload(token, {
          updatedAt: new Date().toISOString(),
          appointments: latestDataRef.current.appointments,
          expenses: latestDataRef.current.expenses,
        });
        setDriveStatus(`Đã tạo file trên Google Drive${label ? ` (${label})` : ""} • ${DRIVE_FILE_NAME}`);
      }
    } catch (err) {
      setDriveStatus(err instanceof Error ? err.message : "Không đọc được Google Drive");
    } finally {
      setIsSyncing(false);
    }
  }

  useEffect(() => {
    if (!initialAuth?.autoSyncEnabled) return;
    let cancelled = false;

    const timer = window.setTimeout(async () => {
      if (cancelled) return;
      if (initialAuth.accessToken && Date.now() < initialAuth.expiresAt) {
        await pullAndMergeFromDrive(initialAuth.accessToken, initialAuth.email);
        return;
      }
      const silentToken = await requestFreshToken({ interactive: false, emailHint: initialAuth.email });
      if (!cancelled && silentToken) {
        await pullAndMergeFromDrive(silentToken, initialAuth.email);
      } else if (!cancelled) {
        setDriveStatus(
          `Đã nhớ tài khoản${initialAuth.email ? ` (${initialAuth.email})` : ""} • Bấm "Đồng bộ Drive" nếu cần làm mới phiên`
        );
      }
    }, 900);

  return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnectDrive() {
    const activeClientId = (clientIdInput || clientId).trim();
    if (!activeClientId) {
      setDriveStatus("Vui lòng nhập Google OAuth Client ID trong tab Cài đặt trước");
      setActiveTab("settings");
      return;
    }
    setClientId(activeClientId);
    if (!window.google?.accounts?.oauth2) {
      setDriveStatus("Chưa tải được thư viện Google Identity Services (thử tải lại trang)");
      return;
    }

    setIsSyncing(true);
    const token = await requestFreshToken({
      interactive: !savedAuth?.autoSyncEnabled,
      emailHint: savedAuth?.email,
    });
    const finalToken = token || (await requestFreshToken({ interactive: true }));
    if (!finalToken) {
      setIsSyncing(false);
      setDriveStatus("Không lấy được quyền truy cập Google Drive");
      return;
    }
    const latestAuth = loadSavedAuth();
    await pullAndMergeFromDrive(finalToken, latestAuth?.email);
  }

  function handleDisconnectDrive() {
    setSavedAuth(null);
    saveAuthToStorage(null);
    setDriveStatus("Đã ngắt kết nối Google Drive (đang dùng bản lưu máy)");
  }

  async function persistChanges(nextAppts: Appointment[], nextExps: BoothExpense[]) {
    setAppointments(nextAppts);
    setExpenses(nextExps);

    if (!savedAuth?.autoSyncEnabled) {
      return;
    }

    const token = await ensureValidDriveToken(false);
    if (token) {
      const latestAuth = loadSavedAuth();
      await pushToDrive(token, nextAppts, nextExps, latestAuth?.email || savedAuth.email);
    } else {
      const interactiveToken = await requestFreshToken({ interactive: true, emailHint: savedAuth.email });
      if (interactiveToken) {
        const latestAuth = loadSavedAuth();
        await pushToDrive(interactiveToken, nextAppts, nextExps, latestAuth?.email || savedAuth.email);
      } else {
        setDriveStatus(
          `Đã lưu trên máy • Bấm "Đồng bộ Drive" để đẩy lên tài khoản${savedAuth.email ? ` (${savedAuth.email})` : ""}`
        );
      }
    }
  }

  const bulkPreview = useMemo(() => {
    const lines = bulkText.split(/\r?\n/);
    const parsed: Array<NonNullable<ReturnType<typeof parseBulkLine>["data"]>> = [];
    const errors: string[] = [];
    for (const line of lines) {
      const res = parseBulkLine(line);
      if (!res.ok) {
        if (res.error) errors.push(res.error);
        continue;
      }
      if (res.data) parsed.push(res.data);
    }
    return { parsed, errors };
  }, [bulkText]);

  async function handleCreateBulkAppointments(e: React.FormEvent) {
    e.preventDefault();
    if (bulkPreview.parsed.length === 0) {
      setBulkFeedback(
        "Vui lòng nhập ít nhất một dòng hợp lệ theo mẫu: Dịch vụ - Tên khách - Ngày - Giờ - Tổng tiền - Đặt cọc - Ghi chú."
      );
      return;
    }

    const createdList: Appointment[] = bulkPreview.parsed.map((item, idx) => {
      const appt: Appointment = {
        id: `APT-${Date.now().toString().slice(-4)}${idx}`,
        serviceContent: item.serviceContent,
        customerName: item.customerName,
        customerPhone: "",
        location: item.location,
        serviceDate: item.serviceDate,
        startTime: item.startTime,
        endTime: item.endTime,
        notes: item.notes,
        totalServiceAmount: item.totalServiceAmount,
        depositAmount: item.depositAmount,
        materialCost: 0,
        laborCost: 0,
        installments: [],
        workStatus: "Đã xác nhận",
        paymentStatus: "Chưa thanh toán",
      };
      appt.paymentStatus = syncPaymentStatus(appt);
      return appt;
    });

    await persistChanges([...createdList, ...appointments], expenses);
    const firstDate = createdList[0].serviceDate;
    setSelectedDateKey(firstDate);
    setCursorDate(parseDateKey(firstDate));
    setBulkText("");
    setBulkFeedback(`Đã thêm thành công ${createdList.length} lịch dịch vụ và cập nhật đồng bộ.`);
    setActiveTab("appointments");
  }

  const financialSummary = useMemo(() => {
    const active = appointments.filter((a) => a.workStatus !== "Đã hủy");
    const totalRevenue = active.reduce((s, a) => s + a.totalServiceAmount, 0);
    const totalDeposit = active.reduce((s, a) => s + a.depositAmount, 0);
    const totalPaid = active.reduce((s, a) => s + getPaidAmount(a), 0);
    const totalDebt = active.reduce((s, a) => s + getRemainingAmount(a), 0);

    const apptMaterial = active.reduce((s, a) => s + (a.materialCost || 0), 0);
    const apptLabor = active.reduce((s, a) => s + (a.laborCost || 0), 0);
    const totalOtherIncome = expenses
      .filter((e) => e.category === "Thu")
      .reduce((s, e) => s + e.amount, 0);
    const extraMaterial = expenses.filter((e) => e.category === "Tiền vật tư").reduce((s, e) => s + e.amount, 0);
    const extraLabor = expenses
      .filter((e) => e.category === "Chi phí công thợ" || (e.category as string) === "Nhân công")
      .reduce((s, e) => s + e.amount, 0);
    const extraOther = expenses.filter((e) => e.category === "Khác").reduce((s, e) => s + e.amount, 0);

    const totalMaterialCost = apptMaterial + extraMaterial;
    const totalLaborCost = apptLabor + extraLabor;
    const totalBoothCost = totalMaterialCost + totalLaborCost + extraOther;
    const totalExpectedIncome = totalRevenue + totalOtherIncome;
    const totalActualReceived = totalPaid + totalOtherIncome;
    const netProfit = totalExpectedIncome - totalBoothCost;
    const actualProfit = totalActualReceived - totalBoothCost;

    return {
      totalRevenue,
      totalOtherIncome,
      totalExpectedIncome,
      totalDeposit,
      totalPaid,
      totalActualReceived,
      totalDebt,
      totalMaterialCost,
      totalLaborCost,
      extraOther,
      totalBoothCost,
      netProfit,
      actualProfit,
    };
  }, [appointments, expenses]);

  const filteredExpenses = useMemo(
    () =>
      expenses.filter((e) => {
        const normCategory: ExpenseCategory =
          (e.category as string) === "Nhân công" ? "Chi phí công thợ" : e.category;
        if (expFilterCategory !== "Tất cả" && normCategory !== expFilterCategory) return false;
        if (!expSearchText.trim()) return true;
        const q = expSearchText.toLowerCase();
        return e.title.toLowerCase().includes(q) || e.note.toLowerCase().includes(q);
      }),
    [expenses, expFilterCategory, expSearchText]
  );

  const customers = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        name: string;
        phone: string;
        count: number;
        totalSpent: number;
        debt: number;
        items: Appointment[];
      }
    >();
    for (const a of appointments) {
      const key = `${a.customerPhone.trim()}__${a.customerName.trim()}`;
      const prev = map.get(key) || {
        key,
        name: a.customerName,
        phone: a.customerPhone,
        count: 0,
        totalSpent: 0,
        debt: 0,
        items: [],
      };
      prev.count += 1;
      prev.totalSpent += a.totalServiceAmount;
      prev.debt += getRemainingAmount(a);
      prev.items.push(a);
      prev.items.sort((x, y) => `${formatDateDMY(y.serviceDate)} ${y.startTime}`.localeCompare(`${formatDateDMY(x.serviceDate)} ${x.startTime}`));
      map.set(key, prev);
    }
    const todayStr = toDateKey(new Date());
    return Array.from(map.values())
      .filter(
        (c) =>
          !searchText.trim() ||
          c.name.toLowerCase().includes(searchText.toLowerCase()) ||
          c.phone.includes(searchText)
      )
      .sort((a, b) => {
        const upcomingA = a.items
          .filter((it) => it.workStatus !== "Đã hủy" && it.serviceDate >= todayStr)
          .sort((x, y) => `${formatDateDMY(x.serviceDate)} ${x.startTime}`.localeCompare(`${formatDateDMY(y.serviceDate)} ${y.startTime}`));
        const upcomingB = b.items
          .filter((it) => it.workStatus !== "Đã hủy" && it.serviceDate >= todayStr)
          .sort((x, y) => `${formatDateDMY(x.serviceDate)} ${x.startTime}`.localeCompare(`${formatDateDMY(y.serviceDate)} ${y.startTime}`));

        const hasUpA = upcomingA.length > 0;
        const hasUpB = upcomingB.length > 0;

        if (hasUpA && !hasUpB) return -1;
        if (!hasUpA && hasUpB) return 1;

        if (hasUpA && hasUpB) {
          const keyA = `${upcomingA[0].serviceDate} ${upcomingA[0].startTime}`;
          const keyB = `${upcomingB[0].serviceDate} ${upcomingB[0].startTime}`;
          const cmp = keyA.localeCompare(keyB);
          if (cmp !== 0) return cmp;
          return a.name.localeCompare(b.name, "vi");
        }

        const pastA = [...a.items].sort((x, y) =>
          `${formatDateDMY(y.serviceDate)} ${y.startTime}`.localeCompare(`${formatDateDMY(x.serviceDate)} ${x.startTime}`)
        );
        const pastB = [...b.items].sort((x, y) =>
          `${formatDateDMY(y.serviceDate)} ${y.startTime}`.localeCompare(`${formatDateDMY(x.serviceDate)} ${x.startTime}`)
        );
        const lastA = pastA[0] ? `${pastA[0].serviceDate} ${pastA[0].startTime}` : "";
        const lastB = pastB[0] ? `${pastB[0].serviceDate} ${pastB[0].startTime}` : "";
        const pastCmp = lastB.localeCompare(lastA);
        if (pastCmp !== 0) return pastCmp;
        return a.name.localeCompare(b.name, "vi");
      });
  }, [appointments, searchText]);

  const filteredAppointments = useMemo(
    () =>
      appointments.filter(
        (a) =>
          !searchText.trim() ||
          a.serviceContent.toLowerCase().includes(searchText.toLowerCase()) ||
          a.customerName.toLowerCase().includes(searchText.toLowerCase()) ||
          a.customerPhone.includes(searchText) ||
          a.location.toLowerCase().includes(searchText.toLowerCase())
      ),
    [appointments, searchText]
  );


  const todayAndUpcomingAppointments = useMemo(() => {
    const todayStr = toDateKey(new Date());
    return filteredAppointments
      .filter((a) => a.workStatus !== "Đã hủy" && a.serviceDate >= todayStr)
      .sort((a, b) =>
        `${formatDateDMY(a.serviceDate)} ${a.startTime}`.localeCompare(`${formatDateDMY(b.serviceDate)} ${b.startTime}`)
      );
  }, [filteredAppointments]);

  const appointmentsByDate = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const a of filteredAppointments) {
      const list = map.get(a.serviceDate) || [];
      list.push(a);
      list.sort((x, y) => x.startTime.localeCompare(y.startTime));
      map.set(a.serviceDate, list);
    }
    return map;
  }, [filteredAppointments]);

  const weekDays = useMemo(() => {
    const monday = getMondayOfWeek(cursorDate);
    return Array.from({ length: 7 }, (_, idx) => {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + idx);
      return {
        date: d,
        key: toDateKey(d),
        label: WEEKDAYS_VI[idx],
        dayNum: d.getDate(),
        monthNum: d.getMonth() + 1,
      };
    });
  }, [cursorDate]);

  const monthCells = useMemo(() => {
    const year = cursorDate.getFullYear();
    const month = cursorDate.getMonth();
    const firstOfMonth = new Date(year, month, 1);
    const gridStart = getMondayOfWeek(firstOfMonth);
    return Array.from({ length: 42 }, (_, idx) => {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + idx);
      return {
        date: d,
        key: toDateKey(d),
        dayNum: d.getDate(),
        inCurrentMonth: d.getMonth() === month,
      };
    });
  }, [cursorDate]);

  const periodTitle = useMemo(() => {
    if (calendarView === "week") {
      const first = weekDays[0];
      const last = weekDays[6];
      return `Tuần ${first.dayNum}/${first.monthNum} – ${last.dayNum}/${last.monthNum}/${last.date.getFullYear()}`;
    }
    return `Tháng ${cursorDate.getMonth() + 1} / ${cursorDate.getFullYear()}`;
  }, [calendarView, weekDays, cursorDate]);

  function handleNavigatePeriod(direction: -1 | 1) {
    setCursorDate((prev) => {
      if (calendarView === "week") {
        return new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + direction * 7);
      }
      return new Date(prev.getFullYear(), prev.getMonth() + direction, 1);
    });
  }

  function handleJumpToday() {
    const now = new Date();
    setCursorDate(now);
    setSelectedDateKey(toDateKey(now));
  }

  async function handleCreateAppointment(e: React.FormEvent) {
    e.preventDefault();
    const total = parseMoneyInput(totalAmount);
    const deposit = parseMoneyInput(depositAmount);
    const lab = parseMoneyInput(laborCost);
    if (!serviceContent.trim() || !customerName.trim()) return;

    const newStart = toMinutes(startTime);
    const newEnd = Math.max(newStart + 30, toMinutes(endTime));

    const conflict = appointments.find(
      (item) =>
        item.workStatus !== "Đã hủy" &&
        item.serviceDate === serviceDate &&
        newStart < toMinutes(item.endTime) &&
        newEnd > toMinutes(item.startTime)
    );
    if (conflict) {
      setConflictAlert(
        `Cảnh báo trùng lịch với "${conflict.serviceContent}" (${conflict.customerName}, ${conflict.startTime} - ${conflict.endTime}). Lịch vẫn được thêm để bạn chủ động sắp xếp.`
      );
    } else {
      setConflictAlert(null);
    }

    const created: Appointment = {
      id: "APT-" + Math.floor(1000 + Math.random() * 9000),
      serviceContent: serviceContent.trim(),
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      location: location.trim() || "Đà Nẵng",
      serviceDate,
      startTime,
      endTime,
      notes: notes.trim(),
      totalServiceAmount: total,
      depositAmount: deposit,
      materialCost: 0,
      laborCost: lab,
      installments: [],
      workStatus: "Đã xác nhận",
      paymentStatus: "Chưa thanh toán",
    };
    created.paymentStatus = syncPaymentStatus(created);

    await persistChanges([created, ...appointments], expenses);
    setSelectedDateKey(serviceDate);
    setCursorDate(parseDateKey(serviceDate));
    setServiceContent("Photobooth");
    setCustomerName("");
    setCustomerPhone("");
    setTotalAmount("");
    setDepositAmount("500,000");
    setLaborCost("");
    setNotes("");
    setActiveTab("appointments");
  }

  async function handleCreateIncome(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseMoneyInput(incAmount);
    if (!incTitle.trim() || amt <= 0) return;

    const created: BoothExpense = {
      id: "INC-" + Math.floor(1000 + Math.random() * 9000),
      date: incDate,
      category: "Thu",
      title: incTitle.trim(),
      amount: amt,
      appointmentId: incAppointmentId || "",
      note: incNote.trim(),
    };
    await persistChanges(appointments, [created, ...expenses]);
    setIncTitle("");
    setIncAmount("");
    setIncAppointmentId("");
    setIncNote("");
  }

  async function handleCreateExpense(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseMoneyInput(expAmount);
    if (!expTitle.trim() || amt <= 0) return;

    const created: BoothExpense = {
      id: (expCategory === "Tiền vật tư" ? "MAT-" : "EXP-") + Math.floor(1000 + Math.random() * 9000),
      date: expDate,
      category: expCategory,
      title: expTitle.trim(),
      amount: amt,
      appointmentId: expAppointmentId || "",
      note: expNote.trim(),
    };
    await persistChanges(appointments, [created, ...expenses]);
    setExpTitle("");
    setExpAmount("");
    setExpAppointmentId("");
    setExpNote("");
  }

  function startEditExpense(exp: BoothExpense) {
    setEditingExpenseId(exp.id);
    setEditExpForm({
      date: exp.date,
      category: (exp.category as string) === "Nhân công" ? "Chi phí công thợ" : exp.category,
      title: exp.title,
      amount: formatCommaNumber(exp.amount),
      appointmentId: exp.appointmentId || "",
      note: exp.note,
    });
  }

  async function saveEditExpense(id: string) {
    if (!editExpForm || !editExpForm.title.trim()) return;
    const amt = parseMoneyInput(editExpForm.amount);
    if (amt <= 0) return;
    const nextExps = expenses.map((item) =>
      item.id === id
        ? {
            id,
            date: editExpForm.date,
            category: editExpForm.category,
            title: editExpForm.title.trim(),
            amount: amt,
            appointmentId: editExpForm.appointmentId || "",
            note: editExpForm.note.trim(),
          }
        : item
    );
    await persistChanges(appointments, nextExps);
    setEditingExpenseId(null);
    setEditExpForm(null);
  }

  async function deleteExpense(id: string) {
    await persistChanges(
      appointments,
      expenses.filter((item) => item.id !== id)
    );
  }

  function startEditAppointment(appt: Appointment) {
    setEditingId(appt.id);
    setEditForm({
      serviceContent: appt.serviceContent,
      customerName: appt.customerName,
      customerPhone: appt.customerPhone,
      location: appt.location,
      serviceDate: appt.serviceDate,
      startTime: appt.startTime,
      endTime: appt.endTime,
      totalServiceAmount: appt.totalServiceAmount ? formatCommaNumber(appt.totalServiceAmount) : "",
      depositAmount: appt.depositAmount ? formatCommaNumber(appt.depositAmount) : "",
      materialCost: appt.materialCost ? formatCommaNumber(appt.materialCost) : "",
      laborCost: appt.laborCost ? formatCommaNumber(appt.laborCost) : "",
      notes: appt.notes,
    });
  }

  async function saveEditAppointment(id: string) {
    if (!editForm || !editForm.serviceContent.trim() || !editForm.customerName.trim()) return;
    const total = parseMoneyInput(editForm.totalServiceAmount);
    const deposit = parseMoneyInput(editForm.depositAmount);
    const mat = parseMoneyInput(editForm.materialCost);
    const lab = parseMoneyInput(editForm.laborCost);

    const nextAppts = appointments.map((a) => {
      if (a.id !== id) return a;
      const updated: Appointment = {
        ...a,
        serviceContent: editForm.serviceContent.trim(),
        customerName: editForm.customerName.trim(),
        customerPhone: editForm.customerPhone.trim(),
        location: editForm.location.trim() || "Đà Nẵng",
        serviceDate: editForm.serviceDate,
        startTime: editForm.startTime,
        endTime: editForm.endTime,
        totalServiceAmount: total,
        depositAmount: deposit,
        materialCost: mat,
        laborCost: lab,
        notes: editForm.notes.trim(),
      };
      updated.paymentStatus = syncPaymentStatus(updated);
      return updated;
    });

    await persistChanges(nextAppts, expenses);
    setEditingId(null);
    setEditForm(null);
  }

  function startEditCustomer(c: { key: string; name: string; phone: string }) {
    setEditingCustomerKey(c.key);
    setCustomerEditName(c.name);
    setCustomerEditPhone(c.phone);
  }

  async function saveEditCustomer(oldName: string, oldPhone: string) {
    if (!customerEditName.trim()) return;
    const nextAppts = appointments.map((a) => {
      if (a.customerName.trim() === oldName.trim() && a.customerPhone.trim() === oldPhone.trim()) {
        return {
          ...a,
          customerName: customerEditName.trim(),
          customerPhone: customerEditPhone.trim(),
        };
      }
      return a;
    });
    await persistChanges(nextAppts, expenses);
    setEditingCustomerKey(null);
  }

  async function deleteCustomerRecords(targetName: string, targetPhone: string) {
    const nextAppts = appointments.filter(
      (a) => !(a.customerName.trim() === targetName.trim() && a.customerPhone.trim() === targetPhone.trim())
    );
    if (selectedCustomerKey === `${targetPhone.trim()}__${targetName.trim()}`) {
      setSelectedCustomerKey(null);
    }
    await persistChanges(nextAppts, expenses);
  }

  async function handleAddInstallment(id: string) {
    const raw = parseMoneyInput(payAmountInput[id] || "");
    if (raw <= 0) return;

    const nextAppts = appointments.map((a) => {
      if (a.id !== id) return a;
      const nextInstallments = [
        ...a.installments,
        { id: String(Date.now()), amount: raw, paidAt: new Date().toISOString().slice(0, 10), note: "Thanh toán đợt" },
      ];
      const updated: Appointment = { ...a, installments: nextInstallments };
      updated.paymentStatus = syncPaymentStatus(updated);
      return updated;
    });

    await persistChanges(nextAppts, expenses);
    setPayAmountInput((prev) => ({ ...prev, [id]: "" }));
  }

  async function handleWorkStatusChange(id: string, nextStatus: WorkStatus) {
    const nextAppts = appointments.map((a) => (a.id === id ? { ...a, workStatus: nextStatus } : a));
    await persistChanges(nextAppts, expenses);
  }

  async function handleDelete(id: string) {
    await persistChanges(
      appointments.filter((a) => a.id !== id),
      expenses
    );
  }

  async function handleResetAllToZero() {
    localStorage.removeItem(APPOINTMENTS_KEY);
    localStorage.removeItem(EXPENSES_KEY);
    setEditingId(null);
    setEditForm(null);
    setEditingCustomerKey(null);
    setSelectedCustomerKey(null);
    setEditingExpenseId(null);
    setEditExpForm(null);
    setConflictAlert(null);
    await persistChanges([], []);
  }

  function handleExportJSON() {
    const payload: DrivePayload = {
      updatedAt: new Date().toISOString(),
      appointments,
      expenses,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = DRIVE_FILE_NAME;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportJSON(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<DrivePayload>;
      const nextAppts = Array.isArray(parsed.appointments) ? parsed.appointments : [];
      const nextExps = Array.isArray(parsed.expenses)
        ? parsed.expenses.map((item) => ({
            ...item,
            category:
              (item.category as string) === "Nhân công" ? ("Chi phí công thợ" as ExpenseCategory) : item.category,
          }))
        : [];
      await persistChanges(nextAppts, nextExps);
      setDriveStatus(`Đã nhập file ${file.name} thành công`);
    } catch {
      setDriveStatus("File JSON không hợp lệ");
    }
    e.target.value = "";
  }

  function handleExportCSV() {
    const header = [
      "ID",
      "Ngay",
      "GioBatDau",
      "GioKetThuc",
      "DichVu",
      "KhachHang",
      "SoDienThoai",
      "DiaDiem",
      "TongTien",
      "DatCoc",
      "DaThanhToan",
      "ConLai",
      "ChiPhiVatTu",
      "ChiPhiCongTho",
      "TongChiPhi",
      "LoiNhuanUocTinh",
      "TrangThaiCongViec",
      "TrangThaiThanhToan",
    ].join(",");

    const rows = appointments.map((a) => {
      const mat = a.materialCost || 0;
      const lab = a.laborCost || 0;
      const linkedExtra = expenses.filter((e) => e.appointmentId === a.id).reduce((s, e) => s + e.amount, 0);
      const totalCost = mat + lab + linkedExtra;
      return [
        a.id,
        a.serviceDate,
        a.startTime,
        a.endTime,
        `"${a.serviceContent.replaceAll('"', '""')}"`,
        `"${a.customerName.replaceAll('"', '""')}"`,
        a.customerPhone,
        `"${a.location.replaceAll('"', '""')}"`,
        a.totalServiceAmount,
        a.depositAmount,
        getPaidAmount(a),
        getRemainingAmount(a),
        mat,
        lab,
        totalCost,
        a.totalServiceAmount - totalCost,
        `"${a.workStatus}"`,
        `"${a.paymentStatus}"`,
      ].join(",");
    });

    const blob = new Blob(["\uFEFF" + [header, ...rows].join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "LITSchedule_GoogleDrive.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  function renderAppointmentCard(appt: Appointment) {
    const isEditing = editingId === appt.id && editForm;
    const paid = getPaidAmount(appt);
    const remaining = getRemainingAmount(appt);
    const linkedExtraExpenses = expenses.filter((e) => e.appointmentId === appt.id);
    const linkedExtraSum = linkedExtraExpenses.reduce((s, e) => s + e.amount, 0);
    const boothCost = getAppointmentBoothCost(appt) + linkedExtraSum;
    const profit = appt.totalServiceAmount - boothCost;

    if (isEditing && editForm) {


  return (
        <div key={appt.id} className="liquid-glass rounded-3xl p-5 space-y-3 border-2 border-sky-400/60">
          <div className="text-xs font-bold text-sky-800">Đang sửa lịch dịch vụ ({appt.id})</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <input
              placeholder="Nội dung dịch vụ *"
              value={editForm.serviceContent}
              onChange={(e) => setEditForm({ ...editForm, serviceContent: e.target.value })}
              className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
            />
            <input
              placeholder="Tên khách hàng *"
              value={editForm.customerName}
              onChange={(e) => setEditForm({ ...editForm, customerName: e.target.value })}
              className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
            />
            <input
              placeholder="Số điện thoại"
              value={editForm.customerPhone}
              onChange={(e) => setEditForm({ ...editForm, customerPhone: e.target.value })}
              className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
            />
            <input
              placeholder="Địa điểm"
              value={editForm.location}
              onChange={(e) => setEditForm({ ...editForm, location: e.target.value })}
              className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
            />
            <input
              type="date"
              value={formatDateDMY(editForm.serviceDate)}
              onChange={(e) => setEditForm({ ...editForm, serviceDate: e.target.value })}
              className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
            />
            <div className="flex gap-2">
              <input
                type="time"
                value={editForm.startTime}
                onChange={(e) => setEditForm({ ...editForm, startTime: e.target.value })}
                className="w-1/2 px-2.5 py-2 rounded-xl bg-white/85 border border-white text-sm"
              />
              <input
                type="time"
                value={editForm.endTime}
                onChange={(e) => setEditForm({ ...editForm, endTime: e.target.value })}
                className="w-1/2 px-2.5 py-2 rounded-xl bg-white/85 border border-white text-sm"
              />
            </div>
            <input
              type="text"
              inputMode="numeric"
              placeholder="Tổng tiền dịch vụ (VNĐ)"
              value={editForm.totalServiceAmount}
              onChange={(e) =>
                setEditForm({ ...editForm, totalServiceAmount: handleThousandInputChange(e.target.value) })
              }
              className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
            />
            <input
              type="text"
              inputMode="numeric"
              placeholder="Tiền đặt cọc (VNĐ)"
              value={editForm.depositAmount}
              onChange={(e) =>
                setEditForm({ ...editForm, depositAmount: handleThousandInputChange(e.target.value) })
              }
              className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
            />
            <input
              type="text"
              inputMode="numeric"
              placeholder="Chi phí công thợ (VNĐ)"
              value={editForm.laborCost}
              onChange={(e) =>
                setEditForm({ ...editForm, laborCost: handleThousandInputChange(e.target.value) })
              }
              className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
            />
            <input
              placeholder="Ghi chú"
              value={editForm.notes}
              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm md:col-span-2"
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => saveEditAppointment(appt.id)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-600 text-white text-xs font-semibold hover:bg-sky-700 cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              Lưu thay đổi
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setEditForm(null);
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/80 text-slate-700 text-xs font-semibold hover:bg-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              Hủy
            </button>
          </div>
        </div>
      );
    }

  return (
      <div key={appt.id} className="liquid-glass rounded-3xl p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-sky-700">
              {formatDateDMY(appt.serviceDate)} • {appt.startTime} - {appt.endTime} • {appt.location}
            </div>
            <h3 className="text-lg font-bold text-slate-900 mt-0.5">{appt.serviceContent}</h3>
            <p className="text-sm text-slate-600">
              Khách hàng: <strong>{appt.customerName}</strong> ({appt.customerPhone || "Chưa có SĐT"})
            </p>
            {appt.notes && <p className="text-xs text-slate-500 mt-0.5">Ghi chú: {appt.notes}</p>}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={appt.workStatus}
              onChange={(e) => handleWorkStatusChange(appt.id, e.target.value as WorkStatus)}
              className="px-3 py-1.5 rounded-xl bg-white/80 border border-white text-xs font-semibold"
            >
              {(["Chờ xác nhận", "Đã xác nhận", "Đang thực hiện", "Hoàn thành", "Đã hủy"] as WorkStatus[]).map(
                (st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                )
              )}
            </select>
            <button
              type="button"
              onClick={() => startEditAppointment(appt)}
              title="Sửa lịch dịch vụ"
              className="p-2 rounded-xl text-sky-700 hover:bg-sky-50 cursor-pointer"
            >
              <Pencil className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => handleDelete(appt.id)}
              title="Xóa lịch dịch vụ"
              className="p-2 rounded-xl text-rose-600 hover:bg-rose-50 cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-white/60 text-sm">
          <div>
            <span className="text-slate-500 block text-xs">Tổng tiền</span>
            <strong>{formatVND(appt.totalServiceAmount)}</strong>
          </div>
          <div>
            <span className="text-slate-500 block text-xs">Đã thanh toán</span>
            <strong className="text-emerald-700">{formatVND(paid)}</strong>
          </div>
          <div>
            <span className="text-slate-500 block text-xs">Còn lại</span>
            <strong className="text-rose-600">{formatVND(remaining)}</strong>
          </div>
          <div>
            <span className="text-slate-500 block text-xs">Trạng thái thanh toán</span>
            <strong className="text-sky-800">{appt.paymentStatus}</strong>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-white/50 text-xs bg-white/35 rounded-2xl px-3 py-2">
          <div>
            <span className="text-slate-500 block">Chi phí công thợ</span>
            <strong className="text-amber-800">{formatVND(appt.laborCost || 0)}</strong>
          </div>
          <div>
            <span className="text-slate-500 block">Tổng chi phí gắn lịch</span>
            <strong className="text-amber-900">{formatVND(boothCost)}</strong>
          </div>
          <div>
            <span className="text-slate-500 block">Lợi nhuận lịch này</span>
            <strong className={profit >= 0 ? "text-emerald-700" : "text-rose-600"}>{formatVND(profit)}</strong>
          </div>
        </div>

        {remaining > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <input
              type="text"
              inputMode="numeric"
              placeholder="Nhập số tiền (VNĐ)..."
              value={payAmountInput[appt.id] || ""}
              onChange={(e) =>
                setPayAmountInput((prev) => ({ ...prev, [appt.id]: handleThousandInputChange(e.target.value) }))
              }
              className="px-3 py-1.5 rounded-xl bg-white/80 border border-white text-sm w-64"
            />
            <button
              type="button"
              onClick={() => handleAddInstallment(appt.id)}
              className="px-3.5 py-1.5 rounded-xl bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 cursor-pointer"
            >
              Ghi nhận thanh toán
            </button>
          </div>
        )}
      </div>
    );
  }

  const todayKey = toDateKey(new Date());
  const selectedDayAppointments = appointmentsByDate.get(selectedDateKey) || [];

  return (
    <div className="min-h-screen pb-28 px-4 pt-6 max-w-6xl mx-auto">
      <header className="liquid-glass rounded-3xl px-6 py-4 mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2">
              <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-lg bg-black text-white text-xs font-extrabold tracking-widest shadow-sm">
                LIT STUDIO
              </span>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-900">
                LIT STUDIO
              </span>
            </span>
            <span
              title={driveStatus}
              className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${
                isSyncing
                  ? "bg-amber-100/90 text-amber-800"
                  : "bg-emerald-100/80 text-emerald-800"
              }`}
            >
              {isSyncing ? (
                <RefreshCw className="w-3.5 h-3.5 text-amber-500 animate-spin" />
              ) : (
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
              )}
              <span>{isSyncing ? "Đang đồng bộ" : "Đã đồng bộ"}</span>
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight mt-1 text-slate-900">
            Quản lý Lịch Dịch vụ, Khách hàng & Tài chính
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleConnectDrive}
            disabled={isSyncing}
            className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-sky-600 text-white text-sm font-medium hover:bg-sky-700 transition cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`} />
            {savedAuth?.autoSyncEnabled ? "Đồng bộ Drive ngay" : "Kết nối Google Drive"}
          </button>
          <button
            type="button"
            onClick={handleExportCSV}
            className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition cursor-pointer"
          >
            <Download className="w-4 h-4" />
            Xuất CSV
          </button>
        </div>
      </header>

      {conflictAlert && (
        <div className="liquid-glass border-amber-300 bg-amber-50/80 rounded-2xl p-4 mb-6 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 text-amber-900 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-600" />
            <span>{conflictAlert}</span>
          </div>
          <button
            type="button"
            onClick={() => setConflictAlert(null)}
            className="text-xs font-semibold text-amber-800 underline cursor-pointer"
          >
            Đóng
          </button>
        </div>
      )}

      {activeTab === "dashboard" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="liquid-glass rounded-3xl p-5">
              <p className="text-xs font-medium text-slate-500">Tổng doanh thu dự kiến</p>
              <p className="text-xl font-bold mt-1 text-slate-900">{formatVND(financialSummary.totalExpectedIncome)}</p>
            </div>
            <div className="liquid-glass rounded-3xl p-5">
              <p className="text-xs font-medium text-slate-500">Đã thanh toán</p>
              <p className="text-xl font-bold mt-1 text-emerald-700">{formatVND(financialSummary.totalActualReceived)}</p>
            </div>
            <div className="liquid-glass rounded-3xl p-5">
              <p className="text-xs font-medium text-slate-500">Công nợ còn lại</p>
              <p className="text-xl font-bold mt-1 text-rose-600">{formatVND(financialSummary.totalDebt)}</p>
            </div>
            <div className="liquid-glass rounded-3xl p-5">
              <p className="text-xs font-medium text-slate-500">Chi phí (Vật tư + Công thợ)</p>
              <p className="text-xl font-bold mt-1 text-amber-800">{formatVND(financialSummary.totalBoothCost)}</p>
            </div>
            <div className="liquid-glass rounded-3xl p-5">
              <p className="text-xs font-medium text-slate-500">Lợi nhuận ròng dự kiến</p>
              <p
                className={`text-xl font-bold mt-1 ${
                  financialSummary.netProfit >= 0 ? "text-sky-700" : "text-rose-600"
                }`}
              >
                {formatVND(financialSummary.netProfit)}
              </p>
            </div>
            <div className="liquid-glass rounded-3xl p-5">
              <p className="text-xs font-medium text-slate-500">Lợi nhuận thực tế (Đã thanh toán − Chi phí)</p>
              <p
                className={`text-xl font-bold mt-1 ${
                  financialSummary.actualProfit >= 0 ? "text-emerald-700" : "text-rose-600"
                }`}
              >
                {formatVND(financialSummary.actualProfit)}
              </p>
            </div>
          </div>

          <form onSubmit={handleCreateAppointment} className="liquid-glass rounded-3xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-lg">
                <Plus className="w-5 h-5 text-sky-600" />
                <span>Tạo lịch dịch vụ mới</span>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <input
                required
                placeholder="Nội dung dịch vụ *"
                value={serviceContent}
                onChange={(e) => setServiceContent(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/75 border border-white/80 text-sm"
              />
              <input
                required
                placeholder="Tên khách hàng *"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/75 border border-white/80 text-sm"
              />
              <input
                placeholder="Số điện thoại"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/75 border border-white/80 text-sm"
              />
              <input
                placeholder="Địa điểm"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/75 border border-white/80 text-sm"
              />
              <input
                type="date"
                value={serviceDate}
                onChange={(e) => setServiceDate(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/75 border border-white/80 text-sm"
              />
              <div className="flex gap-2">
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-1/2 px-3 py-2.5 rounded-2xl bg-white/75 border border-white/80 text-sm"
                />
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-1/2 px-3 py-2.5 rounded-2xl bg-white/75 border border-white/80 text-sm"
                />
              </div>
              <input
                type="text"
                inputMode="numeric"
                placeholder="Tổng tiền dịch vụ (VNĐ)"
                value={totalAmount}
                onChange={(e) => setTotalAmount(handleThousandInputChange(e.target.value))}
                className="px-4 py-2.5 rounded-2xl bg-white/75 border border-white/80 text-sm"
              />
              <input
                type="text"
                inputMode="numeric"
                placeholder="Tiền đặt cọc (VNĐ)"
                value={depositAmount}
                onChange={(e) => setDepositAmount(handleThousandInputChange(e.target.value))}
                className="px-4 py-2.5 rounded-2xl bg-white/75 border border-white/80 text-sm"
              />
              <input
                type="text"
                inputMode="numeric"
                placeholder="Chi phí công thợ (VNĐ)"
                value={laborCost}
                onChange={(e) => setLaborCost(handleThousandInputChange(e.target.value))}
                className="px-4 py-2.5 rounded-2xl bg-white/75 border border-white/80 text-sm"
              />
              <input
                placeholder="Ghi chú"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/75 border border-white/80 text-sm md:col-span-2"
              />
            </div>
            <button
              type="submit"
              className="px-6 py-2.5 rounded-2xl bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 transition cursor-pointer"
            >
              Lưu lịch dịch vụ
            </button>
          </form>
        </div>
      )}

      {activeTab === "appointments" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="liquid-glass rounded-2xl px-4 py-2.5 flex items-center gap-2 flex-1 min-w-[240px]">
              <Search className="w-4 h-4 text-slate-400" />
              <input
                placeholder="Tìm theo dịch vụ, khách hàng, SĐT, địa điểm..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="w-full bg-transparent text-sm focus:outline-none"
              />
            </div>

            <div className="liquid-glass rounded-2xl p-1 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setCalendarView("list")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                  calendarView === "list" ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-white/60"
                }`}
              >
                <List className="w-3.5 h-3.5" />
                Danh sách
              </button>
              <button
                type="button"
                onClick={() => setCalendarView("week")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                  calendarView === "week" ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-white/60"
                }`}
              >
                <CalendarRange className="w-3.5 h-3.5" />
                Tuần
              </button>
              <button
                type="button"
                onClick={() => setCalendarView("month")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                  calendarView === "month" ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-white/60"
                }`}
              >
                <CalendarDays className="w-3.5 h-3.5" />
                Tháng
              </button>
            </div>
          </div>

          {calendarView === "list" && (
            <div className="grid grid-cols-1 gap-4">
              {filteredAppointments.length === 0 ? (
                <div className="liquid-glass rounded-3xl p-6 text-center text-sm text-slate-500">
                  Chưa có lịch dịch vụ nào.
                </div>
              ) : (
                filteredAppointments.map(renderAppointmentCard)
              )}
            </div>
          )}

          {calendarView !== "list" && (
            <div className="space-y-4">
              <div className="liquid-glass rounded-3xl p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="font-bold text-base sm:text-lg text-slate-900">{periodTitle}</div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleNavigatePeriod(-1)}
                    className="p-2 rounded-xl bg-white/80 hover:bg-white border border-white cursor-pointer"
                    title="Trước"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={handleJumpToday}
                    className="px-3 py-1.5 rounded-xl bg-sky-600 text-white text-xs font-semibold hover:bg-sky-700 cursor-pointer"
                  >
                    Hôm nay
                  </button>
                  <button
                    type="button"
                    onClick={() => handleNavigatePeriod(1)}
                    className="p-2 rounded-xl bg-white/80 hover:bg-white border border-white cursor-pointer"
                    title="Tiếp"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {calendarView === "week" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3">
                  {weekDays.map((day) => {
                    const dayAppts = appointmentsByDate.get(day.key) || [];
                    const isSelected = selectedDateKey === day.key;
                    const isToday = todayKey === day.key;

  return (
                      <div
                        key={day.key}
                        onClick={() => setSelectedDateKey(day.key)}
                        className={`liquid-glass rounded-2xl p-3 min-h-[160px] flex flex-col gap-2 cursor-pointer transition ${
                          isSelected ? "ring-2 ring-sky-600 bg-white/75" : "hover:bg-white/65"
                        }`}
                      >
                        <div className="flex items-center justify-between border-b border-white/60 pb-1.5">
                          <span className="text-xs font-bold text-slate-600">{day.label}</span>
                          <span
                            className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                              isToday ? "bg-sky-600 text-white" : "text-slate-800"
                            }`}
                          >
                            {day.dayNum}/{day.monthNum}
                          </span>
                        </div>
                        <div className="space-y-1.5 flex-1">
                          {dayAppts.length === 0 ? (
                            <p className="text-[11px] text-slate-400 italic">Trống lịch</p>
                          ) : (
                            dayAppts.map((a) => (
                              <div
                                key={a.id}
                                className="rounded-xl bg-sky-500/15 border border-sky-500/25 px-2 py-1.5 text-[11px]"
                              >
                                <div className="font-bold text-sky-900">
                                  {a.startTime} - {a.endTime}
                                </div>
                                <div className="font-medium text-slate-800 truncate">{a.serviceContent}</div>
                                <div className="text-slate-600 truncate">{a.customerName}</div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {calendarView === "month" && (
                <div className="liquid-glass rounded-3xl p-4 space-y-2">
                  <div className="grid grid-cols-7 gap-2 text-center text-xs font-bold text-slate-600 pb-1">
                    {WEEKDAYS_VI.map((w) => (
                      <div key={w}>{w}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-2">
                    {monthCells.map((cell) => {
                      const dayAppts = appointmentsByDate.get(cell.key) || [];
                      const isSelected = selectedDateKey === cell.key;
                      const isToday = todayKey === cell.key;

  return (
                        <button
                          type="button"
                          key={cell.key}
                          onClick={() => setSelectedDateKey(cell.key)}
                          className={`text-left rounded-2xl p-2 min-h-[86px] border transition flex flex-col justify-between cursor-pointer ${
                            isSelected
                              ? "bg-white/85 border-sky-600 ring-2 ring-sky-500/40"
                              : cell.inCurrentMonth
                              ? "bg-white/55 border-white/70 hover:bg-white/75"
                              : "bg-white/25 border-white/40 opacity-55"
                          }`}
                        >
                          <div className="flex items-center justify-between w-full">
                            <span
                              className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
                                isToday ? "bg-sky-600 text-white" : "text-slate-800"
                              }`}
                            >
                              <span className="inline-flex items-center gap-1.5"><span>{cell.dayNum}</span>
              {(() => {
                const info = getVietnameseLunarInfo(cell.date);
                return (
                  <span
                    className={`text-[10px] font-medium ${info.isSpecialDay ? "text-rose-600 font-semibold" : "text-slate-400"}`}
                    title={`Âm lịch: ${info.lunarDay}/${info.lunarMonth}${info.isLeap ? " (nhuận)" : ""} năm ${info.lunarYear}`}
                  >
                    {info.label}
                  </span>
                );
              })()}</span>
                            </span>
                            {dayAppts.length > 0 && (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-800">
                                {dayAppts.length} lịch
                              </span>
                            )}
                          </div>
                          <div className="space-y-1 mt-1 w-full">
                            {dayAppts.slice(0, 2).map((a) => (
                              <div
                                key={a.id}
                                className="text-[10px] leading-tight px-1.5 py-0.5 rounded bg-sky-600/15 text-slate-900 font-medium truncate"
                              >
                                {a.startTime} {a.serviceContent}
                              </div>
                            ))}
                            {dayAppts.length > 2 && (
                              <div className="text-[10px] text-sky-700 font-semibold">
                                +{dayAppts.length - 2} lịch khác
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-3 pt-1">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-800">
                    Lịch dịch vụ ngày {selectedDateKey} ({selectedDayAppointments.length})
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      setServiceDate(selectedDateKey);
                      setActiveTab("dashboard");
                    }}
                    className="text-xs font-semibold text-sky-700 hover:underline cursor-pointer"
                  >
                    + Tạo lịch vào ngày này
                  </button>
                </div>

                {selectedDayAppointments.length === 0 ? (
                  <div className="liquid-glass rounded-2xl p-5 text-sm text-slate-500 text-center">
                    Không có lịch dịch vụ nào trong ngày {selectedDateKey}.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4">{selectedDayAppointments.map(renderAppointmentCard)}</div>
                )}
              </div>

              <div className="liquid-glass rounded-3xl p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-bold text-slate-900">
                    Lịch ngày hôm nay và sắp tới ({todayAndUpcomingAppointments.length})
                  </h3>
                  <span className="text-xs text-slate-500">
                    Tên • Ngày • Giờ • Ghi chú
                  </span>
                </div>

                {todayAndUpcomingAppointments.length === 0 ? (
                  <p className="text-sm text-slate-500 py-2">
                    Không có lịch dịch vụ nào từ hôm nay trở đi.
                  </p>
                ) : (
                  <div className="divide-y divide-white/70">
                    {todayAndUpcomingAppointments.sort((a, b) => {
        const parseTs = (item: any) => {
          const rawDate = String(item?.serviceDate ?? item?.date ?? "").trim();
          const rawTime = String(item?.startTime ?? item?.time ?? "00:00").trim();
          let y = 9999, m = 12, d = 31;
          const dmy = rawDate.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
          const ymd = rawDate.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
          if (dmy) {
            d = Number(dmy[1]);
            m = Number(dmy[2]);
            y = Number(dmy[3]);
          } else if (ymd) {
            y = Number(ymd[1]);
            m = Number(ymd[2]);
            d = Number(ymd[3]);
          }
          const tm = rawTime.match(/^(\d{1,2}):(\d{1,2})/);
          const hh = tm ? Number(tm[1]) : 0;
          const mm = tm ? Number(tm[2]) : 0;
          return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
        };
        return parseTs(a) - parseTs(b);
      }).map((item) => {
                      const isTodayItem = item.serviceDate === todayKey;
                      const noteDisplay = item.notes?.trim() || item.location?.trim() || "Không có ghi chú";
                      return (
                        <div
                          key={item.id}
                          className="py-3 flex flex-wrap items-center justify-between gap-2 text-sm"
                        >
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            {isTodayItem && (
                              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-sky-600 text-white">
                                Hôm nay
                              </span>
                            )}
                            <span className="font-bold text-slate-900">
                              {item.customerName} — {item.serviceContent}
                            </span>
                            <span className="text-slate-400">•</span>
                            <span className="font-semibold text-sky-800">{formatDateDMY(item.serviceDate)}</span>
                            <span className="text-slate-400">•</span>
                            <span className="font-medium text-slate-700">
                              {item.startTime} - {item.endTime}
                            </span>
                            <span className="text-slate-400">•</span>
                            <span className="text-slate-600">{noteDisplay}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              
            </div>
          )}
        </div>
      )}

      {activeTab === "customers" && (
        <div className="space-y-4">
          <div className="liquid-glass rounded-2xl px-4 py-3 flex items-center gap-2">
            <Search className="w-4 h-4 text-slate-400" />
            <input
              placeholder="Tìm khách hàng theo tên hoặc SĐT..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="w-full bg-transparent text-sm focus:outline-none"
            />
          </div>

          {customers.length === 0 ? (
            <div className="liquid-glass rounded-3xl p-6 text-center text-sm text-slate-500">
              Chưa có dữ liệu khách hàng nào.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {customers.map((c) => {
                const isEditingCust = editingCustomerKey === c.key;
                const isSelectedCust = selectedCustomerKey === c.key;
                return (
                  <React.Fragment key={c.key}>
                    <div
                      onClick={() => {
                        if (!isEditingCust) {
                          setSelectedCustomerKey(isSelectedCust ? null : c.key);
                        }
                      }}
                      className={`liquid-glass rounded-3xl p-5 space-y-2 transition ${
                        isEditingCust
                          ? ""
                          : isSelectedCust
                          ? "ring-2 ring-sky-600 bg-white/75 cursor-pointer"
                          : "hover:bg-white/70 cursor-pointer"
                      }`}
                    >
                      {isEditingCust ? (
                        <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            placeholder="Tên khách hàng *"
                            value={customerEditName}
                            onChange={(e) => setCustomerEditName(e.target.value)}
                            className="w-full px-3 py-1.5 rounded-xl bg-white/85 border border-white text-sm"
                          />
                          <input
                            placeholder="Số điện thoại"
                            value={customerEditPhone}
                            onChange={(e) => setCustomerEditPhone(e.target.value)}
                            className="w-full px-3 py-1.5 rounded-xl bg-white/85 border border-white text-sm"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => saveEditCustomer(c.name, c.phone)}
                              className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-sky-600 text-white text-xs font-semibold hover:bg-sky-700 cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5" />
                              Lưu
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingCustomerKey(null)}
                              className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white/80 text-slate-700 text-xs font-semibold cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                              Hủy
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div
                                className={`font-bold text-lg transition ${
                                  c.debt > 0
                                    ? "text-rose-600 hover:text-rose-700"
                                    : "text-slate-900 hover:text-sky-700"
                                }`}
                              >
                                {c.name}
                              </div>
                              <div className="text-sm text-slate-600">SĐT: {c.phone || "Chưa cập nhật"}</div>
                              <div className="text-[11px] font-medium text-sky-700 mt-0.5">
                                {isSelectedCust
                                  ? "Đang xem chi tiết dịch vụ bên dưới"
                                  : "Bấm vào để xem đầy đủ dịch vụ"}
                              </div>
                            </div>
                            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={() => startEditCustomer(c)}
                                title="Sửa thông tin khách hàng"
                                className="p-2 rounded-xl text-sky-700 hover:bg-sky-50 cursor-pointer"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteCustomerRecords(c.name, c.phone)}
                                title="Xóa khách hàng & lịch liên quan"
                                className="p-2 rounded-xl text-rose-600 hover:bg-rose-50 cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                          <div className="text-sm flex justify-between pt-2 border-t border-white/60">
                            <span>Số lịch: <strong>{c.count}</strong></span>
                            <span>Tổng giao dịch: <strong>{formatVND(c.totalSpent)}</strong></span>
                            <span className="text-rose-600">Nợ: <strong>{formatVND(c.debt)}</strong></span>
                          </div>
                        </>
                      )}
                    </div>

                    {isSelectedCust && !isEditingCust && (
                      <div className="md:col-span-2 liquid-glass rounded-3xl p-5 space-y-4 border-2 border-sky-400/70">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <span className="text-xs font-semibold uppercase tracking-wider text-sky-700 bg-sky-100/80 px-2.5 py-1 rounded-full">
                              Chi tiết dịch vụ khách hàng
                            </span>
                            <h3 className="text-lg font-bold text-slate-900 mt-1">
                              {c.name}{" "}
                              <span className="text-sm font-normal text-slate-600">
                                ({c.phone || "Chưa cập nhật SĐT"})
                              </span>
                            </h3>
                            <p className="text-xs text-slate-600 mt-0.5">
                              Tổng số lịch: <strong>{c.count}</strong> • Tổng giao dịch:{" "}
                              <strong>{formatVND(c.totalSpent)}</strong> • Còn nợ:{" "}
                              <strong className="text-rose-600">{formatVND(c.debt)}</strong>
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setSelectedCustomerKey(null)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/85 text-slate-700 border border-white text-xs font-semibold hover:bg-white cursor-pointer"
                          >
                            <X className="w-4 h-4" />
                            Đóng chi tiết
                          </button>
                        </div>
                        <div className="grid grid-cols-1 gap-4">
                          {c.items.map(renderAppointmentCard)}
                        </div>
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === "bulk" && (
        <div className="space-y-6">
          <form onSubmit={handleCreateBulkAppointments} className="liquid-glass rounded-3xl p-6 space-y-4">
            <div>
              <div className="flex items-center gap-2 font-semibold text-lg text-slate-900">
                <FileSpreadsheet className="w-5 h-5 text-sky-600" />
                <span>Thêm hàng loạt lịch dịch vụ</span>
              </div>
              <p className="text-xs text-slate-600 mt-1">
                Mỗi dòng một lịch theo thứ tự: <strong>Dịch vụ - Tên khách hàng - Ngày (dd/mm/yyyy) - Giờ bắt đầu-Giờ kết thúc - Tổng tiền - Đặt cọc - Ghi chú</strong>
              </p>
            </div>

            <textarea
              rows={7}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={"Nhập danh sách lịch dịch vụ (mỗi dòng một lịch)...\nVí dụ: Photobooth Pre - Nguyễn Hậu - 12/11/2026 - 10:00-14:00 - 3,490,000 - 500,000 - Nhà hàng Gia Hân"}
              className="w-full px-4 py-3 rounded-2xl bg-white/80 border border-white text-sm font-mono leading-relaxed focus:outline-none"
            />

            {bulkFeedback && (
              <div className="p-3 rounded-2xl bg-sky-50/90 border border-sky-200 text-xs font-medium text-sky-900">
                {bulkFeedback}
              </div>
            )}

            {bulkPreview.errors.length > 0 && (
              <div className="p-3 rounded-2xl bg-rose-50/90 border border-rose-200 text-xs text-rose-800 space-y-1">
                {bulkPreview.errors.map((err, i) => (
                  <div key={i}>• {err}</div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs font-semibold text-slate-700">
                Nhận diện sẵn sàng thêm: <strong className="text-sky-700">{bulkPreview.parsed.length}</strong> lịch dịch vụ
              </span>
              <button
                type="submit"
                className="px-6 py-2.5 rounded-2xl bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 transition cursor-pointer"
              >
                Thêm {bulkPreview.parsed.length} lịch vào hệ thống
              </button>
            </div>
          </form>

          <div className="liquid-glass rounded-3xl p-6 space-y-3">
            <h3 className="text-sm font-bold text-slate-800">
              Xem trước lịch sẽ được tạo ({bulkPreview.parsed.length})
            </h3>
            {bulkPreview.parsed.length === 0 ? (
              <p className="text-xs text-slate-500">Chưa có dòng hợp lệ nào để xem trước.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {bulkPreview.parsed.map((item, idx) => (
                  <div key={idx} className="p-4 rounded-2xl bg-white/70 border border-white text-xs space-y-1">
                    <div className="font-bold text-sky-800">
                      {formatDateDMY(item.serviceDate)} • {item.startTime} - {item.endTime}
                    </div>
                    <div className="font-bold text-sm text-slate-900">
                      {item.serviceContent} — {item.customerName}
                    </div>
                    <div className="text-slate-700">
                      Tổng: <strong>{formatVND(item.totalServiceAmount)}</strong> • Cọc:{" "}
                      <strong className="text-emerald-700">{formatVND(item.depositAmount)}</strong>
                    </div>
                    {item.notes && <div className="text-slate-500">Ghi chú / Địa điểm: {item.notes}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "finance" && (
        <div className="space-y-6">
          <div className="liquid-glass rounded-3xl p-6 space-y-4">
            <h2 className="text-lg font-bold">Báo cáo tài chính, Chi vật tư, Công thợ & Lợi nhuận</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="p-4 rounded-2xl bg-white/65">
                <div className="text-xs text-slate-500">Tổng doanh thu dự kiến</div>
                <div className="text-xl font-bold mt-1">{formatVND(financialSummary.totalExpectedIncome)}</div>
              </div>
              <div className="p-4 rounded-2xl bg-white/65">
                <div className="text-xs text-slate-500">Đã thu thực tế</div>
                <div className="text-xl font-bold text-emerald-700 mt-1">{formatVND(financialSummary.totalActualReceived)}</div>
              </div>
              <div className="p-4 rounded-2xl bg-emerald-50/75 border border-emerald-200/70">
                <div className="text-xs text-emerald-800">Thu khác (In thiệp, in ảnh, ảnh thẻ...)</div>
                <div className="text-xl font-bold text-emerald-900 mt-1">
                  {formatVND(financialSummary.totalOtherIncome)}
                </div>
              </div>
              <div className="p-4 rounded-2xl bg-white/65">
                <div className="text-xs text-slate-500">Còn phải thu (Công nợ)</div>
                <div className="text-xl font-bold text-rose-600 mt-1">{formatVND(financialSummary.totalDebt)}</div>
              </div>
              <div className="p-4 rounded-2xl bg-amber-50/75 border border-amber-200/70">
                <div className="text-xs text-amber-800">Chi phí vật tư (giấy in, mực, đạo cụ...)</div>
                <div className="text-xl font-bold text-amber-900 mt-1">
                  {formatVND(financialSummary.totalMaterialCost)}
                </div>
              </div>
              <div className="p-4 rounded-2xl bg-amber-50/75 border border-amber-200/70">
                <div className="text-xs text-amber-800">Chi phí công thợ</div>
                <div className="text-xl font-bold text-amber-900 mt-1">
                  {formatVND(financialSummary.totalLaborCost)}
                </div>
              </div>
              <div className="p-4 rounded-2xl bg-sky-50/80 border border-sky-200/80">
                <div className="text-xs text-sky-800">Lợi nhuận ròng dự kiến (Doanh thu − Tổng chi phí)</div>
                <div
                  className={`text-xl font-bold mt-1 ${
                    financialSummary.netProfit >= 0 ? "text-sky-800" : "text-rose-600"
                  }`}
                >
                  {formatVND(financialSummary.netProfit)}
                </div>
              </div>
              <div className="p-4 rounded-2xl bg-emerald-50/80 border border-emerald-200/80 sm:col-span-2 lg:col-span-3">
                <div className="text-xs text-emerald-800">Lợi nhuận thực tế (Đã thanh toán − Chi phí)</div>
                <div
                  className={`text-xl font-bold mt-1 ${
                    financialSummary.actualProfit >= 0 ? "text-emerald-800" : "text-rose-600"
                  }`}
                >
                  {formatVND(financialSummary.actualProfit)}
                </div>
              </div>
            </div>
          </div>

                    <form onSubmit={handleCreateIncome} className="liquid-glass rounded-3xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-lg text-slate-900">
                <Receipt className="w-5 h-5 text-emerald-700" />
                <span>Thêm khoản thu (In Thiệp, in ảnh, ảnh thẻ, thu nhập khác...)</span>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <input
                required
                placeholder="Tên khoản thu * (VD: In thiệp cưới, in ảnh, ảnh thẻ...)"
                value={incTitle}
                onChange={(e) => setIncTitle(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/80 border border-white text-sm"
              />
              <input
                required
                type="text"
                inputMode="numeric"
                placeholder="Số tiền thu (VNĐ) *"
                value={incAmount}
                onChange={(e) => setIncAmount(handleThousandInputChange(e.target.value))}
                className="px-4 py-2.5 rounded-2xl bg-white/80 border border-white text-sm"
              />
              <input
                type="date"
                value={incDate}
                onChange={(e) => setIncDate(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/80 border border-white text-sm"
              />
              <select
                value={incAppointmentId}
                onChange={(e) => setIncAppointmentId(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/80 border border-white text-sm"
              >
                <option value="">-- Khoản thu chung (không gắn lịch cụ thể) --</option>
                {appointments.map((a) => (
                  <option key={a.id} value={a.id}>
                    {formatDateDMY(a.serviceDate)} • {a.serviceContent} ({a.customerName})
                  </option>
                ))}
              </select>
              <input
                placeholder="Ghi chú khoản thu (số lượng thiệp, kích thước ảnh...)"
                value={incNote}
                onChange={(e) => setIncNote(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/80 border border-white text-sm md:col-span-2"
              />
            </div>
            <button
              type="submit"
              className="px-6 py-2.5 rounded-2xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition cursor-pointer"
            >
              Lưu khoản thu
            </button>
          </form>

          <form onSubmit={handleCreateExpense} className="liquid-glass rounded-3xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-lg">
                <Receipt className="w-5 h-5 text-amber-700" />
                <span>Thêm khoản chi vật tư, công thợ hoặc chi phí khác</span>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <select
                value={expCategory}
                onChange={(e) => setExpCategory(e.target.value as ExpenseCategory)}
                className="px-4 py-2.5 rounded-2xl bg-white/80 border border-white text-sm font-medium"
              >
                <option value="Thu">Thu (In Thiệp, in ảnh, ảnh thẻ, thu nhập khác...)</option>`n                <option value="Tiền vật tư">Tiền vật tư (giấy in, mực, đạo cụ...)</option>
                <option value="Chi phí công thợ">Chi phí công thợ (trực booth, vận chuyển, dựng...)</option>
                <option value="Khác">Chi phí khác</option>
              </select>
              <input
                required
                placeholder="Tên khoản chi * (VD: Giấy in DNP 4x6, Công trực booth...)"
                value={expTitle}
                onChange={(e) => setExpTitle(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/80 border border-white text-sm"
              />
              <input
                required
                type="text"
                inputMode="numeric"
                placeholder="Số tiền chi (VNĐ) *"
                value={expAmount}
                onChange={(e) => setExpAmount(handleThousandInputChange(e.target.value))}
                className="px-4 py-2.5 rounded-2xl bg-white/80 border border-white text-sm"
              />
              <input
                type="date"
                value={expDate}
                onChange={(e) => setExpDate(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/80 border border-white text-sm"
              />
              <select
                value={expAppointmentId}
                onChange={(e) => setExpAppointmentId(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/80 border border-white text-sm"
              >
                <option value="">-- Chi phí chung (không gắn lịch cụ thể) --</option>
                {appointments.map((a) => (
                  <option key={a.id} value={a.id}>
                    {formatDateDMY(a.serviceDate)} • {a.serviceContent} ({a.customerName})
                  </option>
                ))}
              </select>
              <input
                placeholder="Ghi chú khoản chi"
                value={expNote}
                onChange={(e) => setExpNote(e.target.value)}
                className="px-4 py-2.5 rounded-2xl bg-white/80 border border-white text-sm"
              />
            </div>
            <button
              type="submit"
              className="px-6 py-2.5 rounded-2xl bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 transition cursor-pointer"
            >
              Lưu khoản chi phí
            </button>
          </form>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-bold text-slate-800 px-1">
                Danh sách khoản chi vật tư & chi phí ({filteredExpenses.length})
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <div className="liquid-glass rounded-2xl p-1 flex items-center gap-1">
                  {(["Tất cả", "Thu", "Tiền vật tư", "Chi phí công thợ", "Khác"] as const).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setExpFilterCategory(cat)}
                      className={`px-3 py-1 rounded-xl text-xs font-semibold transition cursor-pointer ${
                        expFilterCategory === cat ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-white/60"
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                <div className="liquid-glass rounded-2xl px-3.5 py-2 flex items-center gap-2 min-w-[210px]">
                  <Search className="w-4 h-4 text-slate-400" />
                  <input
                    placeholder="Tìm tên khoản chi, ghi chú..."
                    value={expSearchText}
                    onChange={(e) => setExpSearchText(e.target.value)}
                    className="w-full bg-transparent text-sm focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {filteredExpenses.length === 0 ? (
              <div className="liquid-glass rounded-3xl p-6 text-center text-sm text-slate-500">
                Chưa có khoản chi vật tư hoặc chi phí nào phù hợp.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                {filteredExpenses.map((exp) => {
                  const isEditingExp = editingExpenseId === exp.id && editExpForm;
                  const linkedAppt = appointments.find((a) => a.id === exp.appointmentId);
                  const displayCategory =
                    (exp.category as string) === "Nhân công" ? "Chi phí công thợ" : exp.category;

                  if (isEditingExp && editExpForm) {


  return (
                      <div key={exp.id} className="liquid-glass rounded-3xl p-4 space-y-3 border-2 border-amber-400/70">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <select
                            value={editExpForm.category}
                            onChange={(e) =>
                              setEditExpForm({ ...editExpForm, category: e.target.value as ExpenseCategory })
                            }
                            className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
                          >
                            <option value="Thu">Thu (In Thiệp, in ảnh, ảnh thẻ...)</option>`n                            <option value="Tiền vật tư">Tiền vật tư</option>
                            <option value="Chi phí công thợ">Chi phí công thợ</option>
                            <option value="Khác">Khác</option>
                          </select>
                          <input
                            value={editExpForm.title}
                            onChange={(e) => setEditExpForm({ ...editExpForm, title: e.target.value })}
                            placeholder="Tên khoản chi *"
                            className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
                          />
                          <input
                            type="text"
                            inputMode="numeric"
                            value={editExpForm.amount}
                            onChange={(e) =>
                              setEditExpForm({ ...editExpForm, amount: handleThousandInputChange(e.target.value) })
                            }
                            placeholder="Số tiền (VNĐ) *"
                            className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
                          />
                          <input
                            type="date"
                            value={formatDateDMY(editExpForm.date)}
                            onChange={(e) => setEditExpForm({ ...editExpForm, date: e.target.value })}
                            className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
                          />
                          <select
                            value={editExpForm.appointmentId}
                            onChange={(e) => setEditExpForm({ ...editExpForm, appointmentId: e.target.value })}
                            className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
                          >
                            <option value="">-- Chi phí chung --</option>
                            {appointments.map((a) => (
                              <option key={a.id} value={a.id}>
                                {formatDateDMY(a.serviceDate)} • {a.serviceContent}
                              </option>
                            ))}
                          </select>
                          <input
                            value={editExpForm.note}
                            onChange={(e) => setEditExpForm({ ...editExpForm, note: e.target.value })}
                            placeholder="Ghi chú"
                            className="px-3 py-2 rounded-xl bg-white/85 border border-white text-sm"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => saveEditExpense(exp.id)}
                            className="flex items-center gap-1 px-3.5 py-1.5 rounded-xl bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 cursor-pointer"
                          >
                            <Check className="w-3.5 h-3.5" />
                            Lưu
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingExpenseId(null);
                              setEditExpForm(null);
                            }}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white/80 text-slate-700 text-xs font-semibold cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                            Hủy
                          </button>
                        </div>
                      </div>
                    );
                  }



  return (
                    <div
                      key={exp.id}
                      className="liquid-glass rounded-3xl p-4 flex flex-wrap items-center justify-between gap-3"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${displayCategory === "Thu" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>
                            {displayCategory}
                          </span>
                          <span className="text-xs text-slate-500">{formatDateDMY(exp.date)}</span>
                        </div>
                        <div className="font-bold text-slate-900 mt-1">{exp.title}</div>
                        {linkedAppt && (
                          <div className="text-xs text-sky-700">
                            Gắn lịch: {linkedAppt.serviceContent} ({linkedAppt.customerName})
                          </div>
                        )}
                        {exp.note && <div className="text-xs text-slate-500">Ghi chú: {exp.note}</div>}
                      </div>
                      <div className="flex items-center gap-3">
                        <strong className={`text-base ${displayCategory === "Thu" ? "text-emerald-700" : "text-amber-900"}`}>{formatVND(exp.amount)}</strong>
                        <button
                          type="button"
                          onClick={() => startEditExpense(exp)}
                          title="Sửa khoản chi"
                          className="p-2 rounded-xl text-sky-700 hover:bg-sky-50 cursor-pointer"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteExpense(exp.id)}
                          title="Xóa khoản chi"
                          className="p-2 rounded-xl text-rose-600 hover:bg-rose-50 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "settings" && (
        <div className="space-y-6">
        <div className="liquid-glass rounded-3xl p-6 space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-lg font-bold">Cài đặt lưu trữ Google Drive</h2>
            {desktopFilePath && (
              <p className="text-xs font-semibold text-sky-900">
                File dữ liệu tự động trên máy Win 64: <code>{desktopFilePath}</code>
              </p>
            )}
            <p className="text-sm text-slate-600">
              Dữ liệu tự động cập nhật vào file <code>{DRIVE_FILE_NAME}</code> trên Google Drive của tài khoản đã đăng nhập mỗi lần thêm hoặc sửa lịch dịch vụ.
            </p>
            {savedAuth?.email && (
              <p className="text-xs font-semibold text-emerald-800">
                Tài khoản Google đang liên kết: {savedAuth.email}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={clientIdInput}
              onChange={(e) => setClientIdInput(e.target.value)}
              placeholder="Google OAuth Client ID (...apps.googleusercontent.com)"
              className="px-4 py-2 rounded-2xl bg-white/80 border border-white text-sm flex-1 min-w-[260px]"
            />
            <button
              type="button"
              onClick={() => {
                setClientId(clientIdInput.trim());
                setDriveStatus("Đã lưu Client ID");
              }}
              className="px-4 py-2 rounded-2xl bg-slate-800 text-white text-sm font-semibold hover:bg-slate-700 cursor-pointer"
            >
              Lưu Client ID
            </button>
            <button
              type="button"
              onClick={handleConnectDrive}
              className="px-4 py-2 rounded-2xl bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 cursor-pointer"
            >
              {savedAuth?.autoSyncEnabled ? "Đồng bộ ngay" : "Kết nối Drive"}
            </button>
            {savedAuth?.autoSyncEnabled && (
              <button
                type="button"
                onClick={handleDisconnectDrive}
                className="flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-white/85 text-slate-800 border border-white text-sm font-semibold hover:bg-white cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                Đăng xuất Drive
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-white/60">
            <button
              type="button"
              onClick={handleExportJSON}
              className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-white/85 text-slate-900 border border-white text-sm font-semibold hover:bg-white cursor-pointer"
            >
              <Download className="w-4 h-4" />
              Tải file JSON ({DRIVE_FILE_NAME})
            </button>

            <label className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-white/85 text-slate-900 border border-white text-sm font-semibold hover:bg-white cursor-pointer">
              <Upload className="w-4 h-4" />
              Nhập file JSON
              <input type="file" accept="application/json,.json" onChange={handleImportJSON} className="hidden" />
            </label>

            
            <button
              type="button"
              onClick={() => exportToXLSM(appointments, expenses)}
              className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Xuất Excel (.xlsm)</span>
            </button>
            <button
              type="button"
              onClick={handleResetAllToZero}
              className="px-4 py-2 rounded-2xl bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 cursor-pointer"
            >
              Xóa toàn bộ dữ liệu (về 0)
            </button>
          </div>
        </div>

        <div className="liquid-glass rounded-3xl p-6 mt-6 space-y-2">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-lg bg-black text-white text-xs font-extrabold tracking-widest">
              LIT STUDIO
            </span>
            <h3 className="text-base font-bold text-slate-900">Giới thiệu ứng dụng</h3>
          </div>
          <p className="text-sm font-medium text-slate-800">
            App quản lý lịch và thu chi
          </p>
          <p className="text-xs text-slate-600">
            Bản quyền bởi <strong>LIT</strong> • Liên hệ: <strong>0935187404</strong>
          </p>
        </div>
        </div>
      )}

      <nav className="fixed bottom-4 left-1/2 -translate-x-1/2 liquid-glass rounded-full px-3 py-2 flex items-center gap-1 sm:gap-2 z-50">
        {(
          [
            ["dashboard", "Tổng quan", LayoutDashboard],
            ["appointments", "Lịch dịch vụ", CalendarClock],
            ["customers", "Khách hàng", Users],
            ["bulk", "Thêm hàng loạt", FileSpreadsheet],
            ["finance", "Tài chính", Wallet],
            ["settings", "Cài đặt", Settings],
          ] as const
        ).map(([key, label, Icon]) => {
          const active = activeTab === key;

  return (
            <button
              type="button"
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs sm:text-sm font-medium transition cursor-pointer ${
                active ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-white/60"
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}



function exportToXLSM(rowsData: any[] = [], expData: any[] = []) {
  const apptList = Array.isArray(rowsData) ? rowsData : [];
  const finList = Array.isArray(expData) ? expData : [];

  function crc32TableInit(): Uint32Array {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  }

  function calcCrc32(data: Uint8Array, table: Uint32Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(u8.length);
    copy.set(u8);
    return copy.buffer;
  }

  function buildZipArchive(entries: Array<{ name: string; content: Uint8Array }>): Blob {
    const encoder = new TextEncoder();
    const crcTable = crc32TableInit();
    const parts: BlobPart[] = [];
    const centralChunks: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const data = entry.content;
      const crc = calcCrc32(data, crcTable);

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      localHeader.set(nameBytes, 30);

      parts.push(toArrayBuffer(localHeader), toArrayBuffer(data));

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);

      centralChunks.push(centralHeader);
      offset += localHeader.length + data.length;
    }

    for (const ch of centralChunks) parts.push(toArrayBuffer(ch));

    const centralSize = centralChunks.reduce((acc, c) => acc + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    parts.push(toArrayBuffer(eocd));

    return new Blob(parts, {
      type: "application/vnd.ms-excel.sheet.macroEnabled.12",
    });
  }

  function escapeXmlText(val: unknown): string {
    return String(val ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function colToLetter(colIndex: number): string {
    let n = colIndex + 1;
    let out = "";
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  function buildSheetXml(rows: Array<Array<string | number>>): string {
    const rowXml = rows
      .map((row, rIdx) => {
        const cells = row
          .map((cell, cIdx) => {
            const ref = `${colToLetter(cIdx)}${rIdx + 1}`;
            if (typeof cell === "number" && Number.isFinite(cell)) {
              return `<c r="${ref}"><v>${cell}</v></c>`;
            }
            return `<c r="${ref}" t="inlineStr"><is><t>${escapeXmlText(cell)}</t></is></c>`;
          })
          .join("");
        return `<row r="${rIdx + 1}">${cells}</row>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  }

  const encoder = new TextEncoder();
  const scheduleRows: Array<Array<string | number>> = [
    [
      "ID",
      "Ngày (dd/mm/yyyy)",
      "Giờ bắt đầu",
      "Giờ kết thúc",
      "Khách hàng",
      "SĐT",
      "Dịch vụ",
      "Địa điểm",
      "Tổng tiền",
      "Đã cọc",
      "Đã thanh toán",
      "Còn lại",
      "Trạng thái làm việc",
      "Trạng thái thanh toán",
      "Ghi chú",
    ],
    ...apptList.map((a: any) => {
      const total = Number(a.totalServiceAmount ?? a.price ?? 0) || 0;
      const deposit = Number(a.depositAmount ?? a.deposit ?? 0) || 0;
      const paid = typeof getPaidAmount === "function" ? getPaidAmount(a) : deposit;
      const rem = typeof getRemainingAmount === "function" ? getRemainingAmount(a) : Math.max(0, total - paid);
      return [
        a.id ?? "",
        typeof formatDateDMY === "function" ? formatDateDMY(a.serviceDate || "") : (a.serviceDate || ""),
        a.startTime ?? "",
        a.endTime ?? "",
        a.customerName ?? "",
        a.customerPhone ?? "",
        a.serviceContent ?? "",
        a.location ?? "",
        total,
        deposit,
        paid,
        rem,
        a.workStatus ?? "",
        a.paymentStatus ?? "",
        a.notes ?? "",
      ];
    }),
  ];

  const financeRows: Array<Array<string | number>> = [
    ["ID", "Ngày (dd/mm/yyyy)", "Loại", "Tên khoản", "Số tiền", "Ghi chú"],
    ...finList.map((e: any) => [
      e.id ?? "",
      typeof formatDateDMY === "function" ? formatDateDMY(e.date || "") : (e.date || ""),
      e.category ?? "",
      e.title ?? "",
      Number(e.amount) || 0,
      e.note ?? "",
    ]),
  ];

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-xmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-xmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-xmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>`;
  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="LichDichVu" sheetId="1" r:id="rId1"/><sheet name="ThuChi" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.microsoft.com/office/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`;
  const vbaStub = new Uint8Array([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);

  const blob = buildZipArchive([
    { name: "[Content_Types].xml", content: encoder.encode(contentTypesXml) },
    { name: "_rels/.rels", content: encoder.encode(rootRelsXml) },
    { name: "xl/workbook.xml", content: encoder.encode(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels", content: encoder.encode(workbookRelsXml) },
    { name: "xl/styles.xml", content: encoder.encode(stylesXml) },
    { name: "xl/worksheets/sheet1.xml", content: encoder.encode(buildSheetXml(scheduleRows)) },
    { name: "xl/worksheets/sheet2.xml", content: encoder.encode(buildSheetXml(financeRows)) },
    { name: "xl/vbaProject.bin", content: vbaStub },
  ]);

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const stamp = typeof toDateKey === "function" ? toDateKey(new Date()) : new Date().toISOString().slice(0, 10);
  link.download = `LIT_Schedule_${stamp}.xlsm`;
  link.click();
  URL.revokeObjectURL(url);
}

export default App;