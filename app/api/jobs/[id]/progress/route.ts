import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let done = false;
      while (!done) {
        try {
          const job = await prisma.job.findUnique({
            where: { id },
            select: {
              processed: true,
              totalEmails: true,
              safe: true,
              risky: true,
              invalid: true,
              unknown: true,
              status: true,
              startedAt: true,
              finishedAt: true,
            },
          });

          if (!job) { controller.close(); return; }

          send(job);

          if (["COMPLETED", "STOPPED", "FAILED"].includes(job.status)) {
            done = true;
            controller.close();
            return;
          }

          await new Promise((r) => setTimeout(r, 2000));
        } catch {
          controller.close();
          return;
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
