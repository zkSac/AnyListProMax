export function errorResponse(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

export function textResponse(msg) {
  return { content: [{ type: "text", text: msg }] };
}

