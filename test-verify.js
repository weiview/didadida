const url = "https://didadida-api-dev.didadida.workers.dev/api/verify-password";
fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: "r32h9rf2hhntg209@P)" })
})
.then(res => res.text())
.then(console.log);
