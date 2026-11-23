import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getNotifications } from "@/lib/actions/notifications";
import NotificationsClient from "./notifications-client";

export const dynamic = "force-dynamic";

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams?: Promise<{ page?: string; unread?: string }>;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const resolvedParams = searchParams ? await searchParams : {};
  const page = parseInt(resolvedParams.page || "1", 10) || 1;
  const unreadOnly = resolvedParams.unread === "true";

  const data = await getNotifications({
    page,
    limit: 15,
    unreadOnly,
  });

  return (
    <NotificationsClient
      initialNotifications={data.notifications}
      initialTotal={data.total}
      initialUnreadCount={data.unreadCount}
      currentPage={data.page}
      pageCount={data.pageCount}
      unreadOnly={unreadOnly}
    />
  );
}
