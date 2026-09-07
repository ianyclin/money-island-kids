export type GardenSpecies = "tree" | "cherry" | "pine" | "sunflower" | "tulip" | "daisy";

export type KidProfile = {
  id: string;
  name: string;
  avatar: string;
  accent: string;
  spendingBalance: number;
  bankBalance: number;
  marketValue: number;
  stockCode: string | null;
  stockUnits: number;
  stockCost: number;
  lastSyncedAt: string | null;
  updatedAt: string;
  rewardClaimedThisMonth?: boolean;
  shortDreamBalance?: number;
  gardenSpecies?: GardenSpecies;
  futurePrincipal?: number;
};

export type MoneyActivity = {
  id: string;
  profileId: string;
  kind: string;
  label: string;
  amount: number;
  spendDelta: number;
  bankDelta: number;
  marketDelta: number;
  note: string;
  entryDate: string;
  source: string;
  operationId?: string | null;
  createdAt: string;
};

export type BackupStatus = {
  id: string;
  reason: string;
  createdAt: string;
  copyStatus?: "pending" | "ready" | "failed";
} | null;

export type FamilyProject = {
  id: string;
  title: string;
  description: string;
  reward: number;
  status: "open" | "claimed" | "waiting" | "completed";
  assignedProfileId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type InvestmentHolding = {
  id: string;
  profileId: string;
  symbol: string;
  name: string;
  category: "ETF" | "股票";
  units: number;
  costBasis: number;
  marketValue: number;
  currency: string;
  quotePrice?: number | null;
  quoteAsOf?: string | null;
  quoteSource?: string | null;
  priceUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvestmentPurchase = {
  id: string;
  profileId: string;
  holdingId: string;
  symbol: string;
  name: string;
  units: number;
  totalCost: number;
  purchaseDate: string;
  note: string;
  operationId?: string | null;
  createdAt: string;
};

export type InvestmentPreset = {
  id: string;
  symbol: string;
  name: string;
  category: "ETF" | "股票";
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DreamJar = {
  id: string;
  profileId: string;
  title: string;
  kind: "short" | "long";
  targetAmount: number;
  balance: number;
  status: "active" | "queued" | "completed";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  completedAmount: number | null;
};

export type MonthlyReflection = {
  id: string;
  profileId: string;
  month: string;
  proudText: string;
  changeText: string;
  planText: string;
  updatedAt: string;
};

export type AnnualHarvest = {
  id: string;
  profileId: string;
  holdingId: string;
  year: number;
  percentage: number;
  soldUnits: number;
  referenceMarketValue: number;
  netProceeds: number;
  marketValueReduction?: number;
  costBasisReduction?: number;
  destinationDreamId: string | null;
  saleDate: string;
  note: string;
  createdAt: string;
};

export type SavingsTransfer = {
  id: string;
  profileId: string;
  amount: number;
  note: string;
  status: "pending" | "approved" | "rejected" | "reversed";
  activityId?: string | null;
  operationId?: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type MoneyState = {
  family?: { id: string; code: string; name: string } | null;
  profiles: KidProfile[];
  activities: MoneyActivity[];
  projects: FamilyProject[];
  holdings: InvestmentHolding[];
  purchases: InvestmentPurchase[];
  investmentPresets: InvestmentPreset[];
  dreamJars: DreamJar[];
  reflections: MonthlyReflection[];
  harvests: AnnualHarvest[];
  savingsTransfers: SavingsTransfer[];
  savingsRate: number;
  latestBackup: BackupStatus;
  backupHealth?: {
    status: "ready" | "pending" | "failed";
    message?: string;
  };
  quoteRefresh?: {
    source: string;
    fetchedAt: string;
    updatedSymbols: string[];
    unavailableSymbols: string[];
  };
};

export type MoneyBackupEnvelope = {
  format: "money-island-backup";
  version: 1;
  exportedAt: string;
  family: { id: string; code: string; name: string };
  state: MoneyState;
};

export type PortableProfilePhoto = {
  profileId: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  base64: string;
};

export type MoneyPortableBackupEnvelope = {
  format: "money-island-portable-backup";
  version: 1;
  exportedAt: string;
  family: { id: string; code: string; name: string };
  state: MoneyState;
  photos: PortableProfilePhoto[];
};

export type TransactionKind = "allowance" | "spend" | "reward";
export type ProjectAction = "create" | "update" | "claim" | "submit" | "approve";
export type DreamAction = "create" | "update" | "update-completed" | "delete" | "complete" | "activate";
export type SavingsTransferAction = "request" | "approve" | "reject";
