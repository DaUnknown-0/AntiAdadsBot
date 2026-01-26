// Response utility functions

export function JsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export function ErrorResponse(message: string, status: number = 400): Response {
  return JsonResponse(
    {
      error: message,
    },
    status
  );
}
