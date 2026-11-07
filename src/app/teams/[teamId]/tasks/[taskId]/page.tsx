import { redirect } from "next/navigation";

// 예전 '작업' 화면 주소. 이제 프로젝트 대화로 합쳐졌다.
export default async function OldTaskPage({ params }: { params: Promise<{ teamId: string; taskId: string }> }) {
  const { teamId, taskId } = await params;
  redirect(`/teams/${encodeURIComponent(teamId)}?p=${encodeURIComponent(taskId)}`);
}
