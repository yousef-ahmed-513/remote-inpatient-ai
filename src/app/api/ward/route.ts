import { requireUser, route } from "@/lib/auth";
import { wardView } from "@/lib/views";

export const GET = route(async () => {
  const user = await requireUser("ward:view");
  return wardView(user);
});
