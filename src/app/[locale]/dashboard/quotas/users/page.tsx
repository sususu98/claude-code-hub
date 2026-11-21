import { Info } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { QuotaToolbar } from "@/components/quota/quota-toolbar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Link, redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { getSystemSettings } from "@/repository/system-config";
import { UsersQuotaSkeleton } from "../_components/users-quota-skeleton";
import { UsersQuotaClient } from "./_components/users-quota-client";
import { loadUsersWithQuotas } from "./_lib/load-users-quotas";

// Force dynamic rendering (this page needs real-time data and auth)
export const dynamic = "force-dynamic";

export default async function UsersQuotaPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await getSession();

  if (session?.user.role !== "admin") {
    return redirect({ href: session ? "/dashboard/my-quota" : "/login", locale });
  }

  const t = await getTranslations({ locale, namespace: "quota.users" });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">{t("title")}</h3>
        </div>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          {t("manageNotice")}{" "}
          <Link href="/dashboard/users" className="font-medium underline underline-offset-4">
            {t("manageLink")}
          </Link>
        </AlertDescription>
      </Alert>

      <QuotaToolbar
        sortOptions={[
          { value: "name", label: t("sort.name") },
          { value: "usage", label: t("sort.usage") },
        ]}
        filterOptions={[
          { value: "all", label: t("filter.all") },
          { value: "warning", label: t("filter.warning") },
          { value: "exceeded", label: t("filter.exceeded") },
        ]}
      />

      <Suspense fallback={<UsersQuotaSkeleton />}>
        <UsersQuotaContent locale={locale} />
      </Suspense>
    </div>
  );
}

async function UsersQuotaContent({ locale }: { locale: string }) {
  const [users, systemSettings] = await Promise.all([loadUsersWithQuotas(), getSystemSettings()]);
  const t = await getTranslations({ locale, namespace: "quota.users" });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("totalCount", { count: users.length })}</p>
      <UsersQuotaClient users={users} currencyCode={systemSettings.currencyDisplay} />
    </div>
  );
}
