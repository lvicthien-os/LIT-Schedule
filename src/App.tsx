import React, { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Users,
  Wallet,
  Settings,
  Download,
  Trash2,
  CalendarDays,
  RefreshCw,
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


function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

function createInitialAppointments(): Appointment[] {
  const todayKey = toDateKey(new Date());
  return [
    {
      id: "apt-1",
      customerName: "Mỹ Duyên",
      customerPhone: "0905123456",
      serviceContent: "Photobooth Pre",
      location: "Hoa Cau Ái Nghĩa",
      serviceDate: todayKey,
      startTime: "10:00",
      endTime: "14:00",
      totalServiceAmount: 4500000,
      depositAmount: 1500000,
      materialCost: 300000,
      laborCost: 500000,
      installments: [],
      workStatus: "Đã xác nhận",
      paymentStatus: "Đã đặt cọc",
      notes: "",
    },
    {
      id: "apt-2",
      customerName: "Nguyễn Hậu",
      customerPhone: "0912345678",
      serviceContent: "Photobooth Pre",
      location: "Gia Hân 2/9",
      serviceDate: "2026-11-25",
      startTime: "10:00",
      endTime: "14:00",
      totalServiceAmount: 4500000,
      depositAmount: 1000000,
      materialCost: 250000,
      laborCost: 500000,
      installments: [],
      workStatus: "Đã xác nhận",
      paymentStatus: "Đã đặt cọc",
      notes: "",
    },
  ];
}

function createInitialExpenses(): BoothExpense[] {
  return [
    {
      id: "exp-1",
      date: toDateKey(new Date()),
      category: "Thu",
      title: "Cọc lịch Mỹ Duyên",
      amount: 1500000,
      note: "Chuyển khoản",
    },
  ];
}

function toMonthKey(dateKey: string): string {
  const m = String(dateKey || "").trim().match(/^(\d{4})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  return toDateKey(new Date()).slice(0, 7);
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("dashboard");
  const [calendarView, setCalendarView] = useState<CalendarViewMode>("list");
  const [appointments, setAppointments] = useState<Appointment[]>(() => {
    try {
      const raw = localStorage.getItem(APPOINTMENTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return createInitialAppointments();
  });
  const [expenses, setExpenses] = useState<BoothExpense[]>(() => {
    try {
      const raw = localStorage.getItem(EXPENSES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return createInitialExpenses();
  });

  const [clientId, setClientId] = useState<string>(() => {
    try {
      return localStorage.getItem(CLIENT_ID_STORAGE) || DEFAULT_CLIENT_ID;
    } catch {
      return DEFAULT_CLIENT_ID;
    }
  });
  const [driveAuth, setDriveAuth] = useState<SavedDriveAuth | null>(() => {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SavedDriveAuth;
      return parsed && parsed.accessToken ? parsed : null;
    } catch {
      return null;
    }
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string>("");

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMonth, setSelectedMonth] = useState<string>(() => toMonthKey(toDateKey(new Date())));
  const [bulkInput, setBulkInput] = useState("");
  const [bulkPreview, setBulkPreview] = useState<ReturnType<typeof parseBulkLine>[]>([]);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [serviceContent, setServiceContent] = useState("Photobooth Pre");
  const [location, setLocation] = useState("");
  const [serviceDate, setServiceDate] = useState(() => toDateKey(new Date()));
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("14:00");
  const [totalInput, setTotalInput] = useState("4.500.000");
  const [depositInput, setDepositInput] = useState("1.500.000");
  const [materialInput, setMaterialInput] = useState("0");
  const [laborInput, setLaborInput] = useState("0");
  const [notes, setNotes] = useState("");

  const [expCategory, setExpCategory] = useState<ExpenseCategory>("Chi phí công thợ");
  const [expTitle, setExpTitle] = useState("");
  const [expAmountInput, setExpAmountInput] = useState("");
  const [expDate, setExpDate] = useState(() => toDateKey(new Date()));

  useEffect(() => {
    try {
      localStorage.setItem(APPOINTMENTS_KEY, JSON.stringify(appointments));
    } catch {}
  }, [appointments]);

  useEffect(() => {
    try {
      localStorage.setItem(EXPENSES_KEY, JSON.stringify(expenses));
    } catch {}
  }, [expenses]);

  useEffect(() => {
    try {
      localStorage.setItem(CLIENT_ID_STORAGE, clientId);
    } catch {}
  }, [clientId]);

  useEffect(() => {
    try {
      if (driveAuth) localStorage.setItem(AUTH_STORAGE, JSON.stringify(driveAuth));
      else localStorage.removeItem(AUTH_STORAGE);
    } catch {}
  }, [driveAuth]);

  function handleConnectDrive() {
    const trimmed = (clientId || "").trim();
    if (!trimmed) {
      setSyncMessage("Vui lòng nhập Google Client ID trong Cài đặt.");
      return;
    }
    const g = (window as unknown as {
      google?: {
        accounts?: {
          oauth2?: {
            initTokenClient?: (cfg: {
              client_id: string;
              scope: string;
              callback: (resp: { access_token?: string; expires_in?: number; error?: string }) => void;
            }) => { requestAccessToken: (opts?: { prompt?: string }) => void };
          };
        };
      };
    }).google;

    if (!g?.accounts?.oauth2?.initTokenClient) {
      setSyncMessage("Chưa tải được Google Identity Services. Kiểm tra kết nối mạng.");
      return;
    }

    const tokenClient = g.accounts.oauth2.initTokenClient({
      client_id: trimmed,
      scope: DRIVE_SCOPE,
      callback: async (resp) => {
        if (resp.error || !resp.access_token) {
          setSyncMessage("Đăng nhập Google Drive không thành công.");
          return;
        }
        let email = driveAuth?.email || "";
        try {
          const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${resp.access_token}` },
          });
          if (infoRes.ok) {
            const info = await infoRes.json();
            email = info.email || email;
          }
        } catch {}

        setDriveAuth({
          accessToken: resp.access_token,
          expiresAt: Date.now() + (resp.expires_in || 3600) * 1000,
          email,
          autoSyncEnabled: driveAuth?.autoSyncEnabled ?? true,
        });
        setSyncMessage(email ? `Đã kết nối Drive: ${email}` : "Đã kết nối Google Drive.");
      },
    });

    tokenClient.requestAccessToken({ prompt: "" });
  }

  async function handleManualSync() {
    if (!driveAuth?.accessToken) {
      handleConnectDrive();
      return;
    }
    setIsSyncing(true);
    setSyncMessage("Đang đồng bộ dữ liệu lên Google Drive...");
    try {
      const payload = JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          appointments,
          expenses,
        },
        null,
        2
      );

      const q = encodeURIComponent(`name = '${DRIVE_FILE_NAME}' and trashed = false`);
      const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
        headers: { Authorization: `Bearer ${driveAuth.accessToken}` },
      });
      if (!listRes.ok) {
        throw new Error(`Drive list error ${listRes.status}`);
      }
      const listData = await listRes.json();
      const existingFile = Array.isArray(listData.files) && listData.files[0];

      const boundary = "lit_schedule_boundary_" + Date.now();
      const metadata = JSON.stringify({
        name: DRIVE_FILE_NAME,
        mimeType: "application/json",
      });
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;

      const uploadUrl = existingFile
        ? `https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=multipart`
        : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
      const method = existingFile ? "PATCH" : "POST";

      const upRes = await fetch(uploadUrl, {
        method,
        headers: {
          Authorization: `Bearer ${driveAuth.accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      });
      if (!upRes.ok) {
        throw new Error(`Drive upload error ${upRes.status}`);
      }
      setSyncMessage(`Đã đồng bộ Drive lúc ${new Date().toLocaleTimeString("vi-VN")}`);
    } catch {
      setSyncMessage("Đồng bộ thất bại. Vui lòng thử kết nối lại Google Drive.");
    } finally {
      setIsSyncing(false);
    }
  }

  function handleAddAppointment(e: React.FormEvent) {
    e.preventDefault();
    if (!customerName.trim()) return;
    const total = parseMoneyInput(totalInput);
    const deposit = parseMoneyInput(depositInput);
    const material = parseMoneyInput(materialInput);
    const labor = parseMoneyInput(laborInput);
    const paymentStatus: PaymentStatus =
      deposit >= total && total > 0 ? "Đã thanh toán đủ" : deposit > 0 ? "Đã đặt cọc" : "Chưa thanh toán";

    const newApt: Appointment = {
      id: "apt-" + Date.now(),
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      serviceContent: serviceContent.trim() || "Photobooth Pre",
      location: location.trim(),
      serviceDate,
      startTime,
      endTime,
      totalServiceAmount: total,
      depositAmount: deposit,
      materialCost: material,
      laborCost: labor,
      installments: [],
      workStatus: "Đã xác nhận",
      paymentStatus,
      notes: notes.trim(),
    };
    setAppointments((prev) => [newApt, ...prev]);
    setCustomerName("");
    setCustomerPhone("");
    setLocation("");
    setNotes("");
  }

  function handleAddExpense(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseMoneyInput(expAmountInput);
    if (!expTitle.trim() || amount <= 0) return;
    const item: BoothExpense = {
      id: "exp-" + Date.now(),
      date: expDate,
      category: expCategory,
      title: expTitle.trim(),
      amount,
      note: "",
    };
    setExpenses((prev) => [item, ...prev]);
    setExpTitle("");
    setExpAmountInput("");
  }

  function handleParseBulk() {
    const lines = bulkInput
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    setBulkPreview(lines.map(parseBulkLine));
  }

  function handleImportBulk() {
    const valid: Appointment[] = [];
    bulkPreview.forEach((item, idx) => {
      if (!item.ok || !item.data) return;
      const d = item.data;
      valid.push({
        id: "apt-bulk-" + Date.now() + "-" + idx,
        customerName: d.customerName,
        customerPhone: "",
        serviceContent: d.serviceContent || "Photobooth Pre",
        location: d.location || "",
        serviceDate: d.serviceDate || toDateKey(new Date()),
        startTime: d.startTime || "10:00",
        endTime: d.endTime || "14:00",
        totalServiceAmount: d.totalServiceAmount || 0,
        depositAmount: d.depositAmount || 0,
        materialCost: 0,
        laborCost: 0,
        installments: [],
        workStatus: "Đã xác nhận",
        paymentStatus: d.depositAmount > 0 ? "Đã đặt cọc" : "Chưa thanh toán",
        notes: d.notes || "",
      });
    });
    if (valid.length === 0) return;
    setAppointments((prev) => [...valid, ...prev]);
    setBulkInput("");
    setBulkPreview([]);
    setActiveTab("appointments");
  }

  function handleResetAllToZero() {
    setAppointments([]);
    setExpenses([]);
    setSyncMessage("Đã đặt toàn bộ dữ liệu về 0.");
  }

  function exportToCSV() {
    const headers = [
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
    ];
    const rows = appointments.map((a) => [
      a.id,
      formatDateDMY(a.serviceDate),
      a.startTime,
      a.endTime,
      a.customerName,
      a.customerPhone || "",
      a.serviceContent,
      a.location || "",
      a.totalServiceAmount,
      a.depositAmount,
      getPaidAmount(a),
      getRemainingAmount(a),
      a.workStatus,
      a.paymentStatus,
      a.notes || "",
    ]);
    const csvContent =
      "\uFEFF" +
      [headers, ...rows]
        .map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
        .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `LIT_Schedule_${toDateKey(new Date())}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportToXLSM() {
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
      let s = "";
      while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s;
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
      ...appointments.map((a) => [
        a.id,
        formatDateDMY(a.serviceDate),
        a.startTime,
        a.endTime,
        a.customerName,
        a.customerPhone || "",
        a.serviceContent,
        a.location || "",
        a.totalServiceAmount,
        a.depositAmount,
        getPaidAmount(a),
        getRemainingAmount(a),
        a.workStatus,
        a.paymentStatus,
        a.notes || "",
      ]),
    ];

    const financeRows: Array<Array<string | number>> = [
      ["ID", "Ngày (dd/mm/yyyy)", "Loại", "Tên khoản", "Số tiền", "Ghi chú"],
      ...expenses.map((e) => [
        e.id,
        formatDateDMY(e.date),
        e.category,
        e.title,
        e.amount,
        e.note || "",
      ]),
    ];

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-xmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-xmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-xmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>`;
    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="LichDichVu" sheetId="1" r:id="rId1"/><sheet name="ThuChi" sheetId="2" r:id="rId2"/></sheets></workbook>`;
    const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>`;
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
    link.download = `LIT_Schedule_${toDateKey(new Date())}.xlsm`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const todayStr = toDateKey(new Date());
  const upcomingAppointments = [...appointments]
    .filter((a) => a.serviceDate >= todayStr)
    .sort((a, b) => (a.serviceDate + a.startTime).localeCompare(b.serviceDate + b.startTime));

  const filteredAppointments = appointments.filter((a) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      a.customerName.toLowerCase().includes(q) ||
      a.serviceContent.toLowerCase().includes(q) ||
      (a.location || "").toLowerCase().includes(q) ||
      formatDateDMY(a.serviceDate).includes(q)
    );
  });

  const monthIncome =
    appointments
      .filter((a) => toMonthKey(a.serviceDate) === selectedMonth)
      .reduce((sum, a) => sum + getPaidAmount(a), 0) +
    expenses
      .filter((e) => toMonthKey(e.date) === selectedMonth && e.category === "Thu")
      .reduce((sum, e) => sum + e.amount, 0);

  const monthExpense =
    expenses
      .filter((e) => toMonthKey(e.date) === selectedMonth && e.category !== "Thu")
      .reduce((sum, e) => sum + e.amount, 0) +
    appointments
      .filter((a) => toMonthKey(a.serviceDate) === selectedMonth)
      .reduce((sum, a) => sum + getAppointmentBoothCost(a), 0);

  const navItems: Array<{ key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { key: "dashboard", label: "Tổng quan", icon: LayoutDashboard },
    { key: "appointments", label: "Lịch dịch vụ", icon: CalendarDays },
    { key: "customers", label: "Khách hàng", icon: Users },
    { key: "bulk", label: "Thêm hàng loạt", icon: Settings },
    { key: "finance", label: "Tài chính", icon: Wallet },
    { key: "settings", label: "Cài đặt", icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 pb-24 md:pb-10">
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-slate-200 px-4 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-slate-900 text-white flex items-center justify-center font-bold">
              LIT
            </div>
            <div>
              <h1 className="font-bold text-base leading-tight">LIT Schedule</h1>
              <p className="text-xs text-slate-500">
                {driveAuth?.email ? `Drive: ${driveAuth.email}` : "Chế độ ngoại tuyến / Google Drive"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleManualSync}
              disabled={isSyncing}
              title={isSyncing ? "Đang đồng bộ Drive..." : "Đồng bộ Drive ngay"}
              aria-label="Đồng bộ Drive ngay"
              className="flex items-center justify-center p-2.5 rounded-2xl bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-60 transition cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
        {syncMessage && (
          <div className="max-w-6xl mx-auto mt-2 text-xs text-sky-700 bg-sky-50 px-3 py-1.5 rounded-xl">
            {syncMessage}
          </div>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-4 pt-5 space-y-6">
        <div className="hidden md:flex items-center gap-2 bg-white p-1.5 rounded-2xl border border-slate-200 w-fit">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium transition cursor-pointer ${
                  active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        {activeTab === "dashboard" && (
          <section className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white p-4 rounded-2xl border border-slate-200">
                <p className="text-xs text-slate-500">Lịch sắp tới</p>
                <p className="text-2xl font-bold mt-1">{upcomingAppointments.length}</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200">
                <p className="text-xs text-slate-500">Thu tháng ({selectedMonth})</p>
                <p className="text-2xl font-bold text-emerald-600 mt-1">{formatVND(monthIncome)}</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200">
                <p className="text-xs text-slate-500">Chi tháng ({selectedMonth})</p>
                <p className="text-2xl font-bold text-rose-600 mt-1">{formatVND(monthExpense)}</p>
              </div>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-slate-200 space-y-3">
              <h2 className="font-semibold text-base">
                Lịch ngày hôm nay và sắp tới ({upcomingAppointments.length})
              </h2>
              {upcomingAppointments.length === 0 ? (
                <p className="text-sm text-slate-500">Chưa có lịch sắp tới.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {upcomingAppointments.map((a) => (
                    <div key={a.id} className="py-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      {a.serviceDate === todayStr && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-sky-100 text-sky-700">
                          Hôm nay
                        </span>
                      )}
                      <span className="font-semibold">{a.customerName}</span>
                      <span>—</span>
                      <span>{a.serviceContent}</span>
                      <span>•</span>
                      <span className="font-medium text-slate-700">{formatDateDMY(a.serviceDate)}</span>
                      <span>•</span>
                      <span>
                        {a.startTime} - {a.endTime}
                      </span>
                      {a.location && (
                        <>
                          <span>•</span>
                          <span className="text-slate-600">{a.location}</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {activeTab === "appointments" && (
          <section className="space-y-4">
            <div className="bg-white p-5 rounded-2xl border border-slate-200">
              <h2 className="font-semibold text-base mb-3">Thêm lịch dịch vụ</h2>
              <form onSubmit={handleAddAppointment} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <input
                  type="text"
                  placeholder="Tên khách hàng *"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <input
                  type="text"
                  placeholder="Số điện thoại"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <input
                  type="text"
                  placeholder="Dịch vụ"
                  value={serviceContent}
                  onChange={(e) => setServiceContent(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <input
                  type="text"
                  placeholder="Địa điểm"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <input
                  type="date"
                  value={serviceDate}
                  onChange={(e) => setServiceDate(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <input
                  type="text"
                  placeholder="Tổng tiền"
                  value={totalInput}
                  onChange={(e) => setTotalInput(handleThousandInputChange(e.target.value))}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <input
                  type="text"
                  placeholder="Đã cọc"
                  value={depositInput}
                  onChange={(e) => setDepositInput(handleThousandInputChange(e.target.value))}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <input
                  type="text"
                  placeholder="Chi phí vật tư"
                  value={materialInput}
                  onChange={(e) => setMaterialInput(handleThousandInputChange(e.target.value))}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <input
                  type="text"
                  placeholder="Chi phí nhân công"
                  value={laborInput}
                  onChange={(e) => setLaborInput(handleThousandInputChange(e.target.value))}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <input
                  type="text"
                  placeholder="Ghi chú"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <button
                  type="submit"
                  className="sm:col-span-2 lg:col-span-4 py-2.5 px-4 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 cursor-pointer"
                >
                  Lưu lịch dịch vụ
                </button>
              </form>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-slate-200 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold text-base">Danh sách lịch ({filteredAppointments.length})</h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCalendarView("list")}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer ${
                      calendarView === "list" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    Danh sách
                  </button>
                  <button
                    type="button"
                    onClick={() => setCalendarView("month")}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer ${
                      calendarView === "month" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    Tháng
                  </button>
                  <input
                    type="text"
                    placeholder="Tìm tên, dịch vụ, dd/mm/yyyy..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="px-3 py-1.5 rounded-xl border border-slate-300 text-xs"
                  />
                </div>
              </div>

              <div className="divide-y divide-slate-100">
                {filteredAppointments.map((a) => (
                  <div key={a.id} className="py-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div>
                      <div className="font-semibold">
                        {a.customerName} — {a.serviceContent}
                      </div>
                      <div className="text-xs text-slate-500">
                        {formatDateDMY(a.serviceDate)} • {a.startTime} - {a.endTime}
                        {a.location ? ` • ${a.location}` : ""}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold text-slate-800">{formatVND(a.totalServiceAmount)}</div>
                      <div className="text-xs text-slate-500">Còn lại: {formatVND(getRemainingAmount(a))}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {activeTab === "customers" && (
          <section className="bg-white p-5 rounded-2xl border border-slate-200 space-y-3">
            <h2 className="font-semibold text-base">Khách hàng ({appointments.length} lịch)</h2>
            <div className="divide-y divide-slate-100 text-sm">
              {appointments.map((a) => (
                <div key={a.id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <span className="font-semibold">{a.customerName}</span>
                    {a.customerPhone && <span className="text-slate-500 ml-2">{a.customerPhone}</span>}
                  </div>
                  <span className="text-xs text-slate-500">{formatDateDMY(a.serviceDate)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeTab === "bulk" && (
          <section className="bg-white p-5 rounded-2xl border border-slate-200 space-y-3">
            <h2 className="font-semibold text-base">Thêm lịch hàng loạt</h2>
            <textarea
              rows={5}
              value={bulkInput}
              onChange={(e) => setBulkInput(e.target.value)}
              placeholder="Mỗi dòng 1 lịch, ví dụ: Mỹ Duyên | Photobooth Pre | 22/11/2026 | 10:00-14:00 | Hoa Cau | 4500000 | 1500000"
              className="w-full p-3 rounded-xl border border-slate-300 text-sm"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleParseBulk}
                className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-medium cursor-pointer"
              >
                Xem trước
              </button>
              {bulkPreview.length > 0 && (
                <button
                  type="button"
                  onClick={handleImportBulk}
                  className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium cursor-pointer"
                >
                  Nhập {bulkPreview.filter((x) => x.ok).length} lịch hợp lệ
                </button>
              )}
            </div>
          </section>
        )}

        {activeTab === "finance" && (
          <section className="bg-white p-5 rounded-2xl border border-slate-200 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold text-base">Sổ thu chi</h2>
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="px-3 py-1.5 rounded-xl border border-slate-300 text-sm"
              />
            </div>

            <form onSubmit={handleAddExpense} className="grid grid-cols-1 sm:grid-cols-5 gap-2">
              <select
                value={expCategory}
                onChange={(e) => setExpCategory(e.target.value as ExpenseCategory)}
                className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
              >
                <option value="Thu">Thu</option>
                <option value="Tiền vật tư">Tiền vật tư</option>
                <option value="Chi phí công thợ">Chi phí công thợ</option>
                <option value="Khác">Khác</option>
              </select>
              <input
                type="text"
                placeholder="Tên khoản"
                value={expTitle}
                onChange={(e) => setExpTitle(e.target.value)}
                className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
              />
              <input
                type="text"
                placeholder="Số tiền"
                value={expAmountInput}
                onChange={(e) => setExpAmountInput(handleThousandInputChange(e.target.value))}
                className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
              />
              <input
                type="date"
                value={expDate}
                onChange={(e) => setExpDate(e.target.value)}
                className="px-3 py-2 rounded-xl border border-slate-300 text-sm"
              />
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-medium cursor-pointer"
              >
                Thêm khoản
              </button>
            </form>

            <div className="divide-y divide-slate-100 text-sm">
              {expenses.map((ex) => (
                <div key={ex.id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <span className="font-medium">{ex.title}</span>
                    <span className="text-xs text-slate-500 ml-2">{formatDateDMY(ex.date)}</span>
                  </div>
                  <span className={ex.category === "Thu" ? "text-emerald-600 font-semibold" : "text-rose-600 font-semibold"}>
                    {ex.category === "Thu" ? "+" : "-"}
                    {formatVND(ex.amount)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeTab === "settings" && (
          <section className="bg-white p-5 rounded-2xl border border-slate-200 space-y-5">
            <h2 className="font-semibold text-base">Cài đặt & Dữ liệu</h2>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-600">Google OAuth Client ID</label>
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="flex-1 min-w-[240px] px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
                <button
                  type="button"
                  onClick={handleConnectDrive}
                  className="px-4 py-2 rounded-xl bg-sky-600 text-white text-sm font-medium hover:bg-sky-700 cursor-pointer"
                >
                  Kết nối Google Drive
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={exportToCSV}
                className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Xuất CSV</span>
              </button>
              <button
                type="button"
                onClick={exportToXLSM}
                className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Xuất Excel (.xlsm)</span>
              </button>
              <button
                type="button"
                onClick={handleResetAllToZero}
                className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-rose-50 text-rose-700 border border-rose-200 text-sm font-medium hover:bg-rose-100 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                <span>Đặt tất cả về 0</span>
              </button>
            </div>
          </section>
        )}
      </main>

      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-slate-200 grid grid-cols-6">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveTab(item.key)}
              className={`flex flex-col items-center justify-center py-2 text-[11px] font-medium cursor-pointer ${
                active ? "text-slate-900 bg-slate-100" : "text-slate-500"
              }`}
            >
              <Icon className="w-4 h-4 mb-0.5" />
              <span className="truncate max-w-full px-1">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export default App;
