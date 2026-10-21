'use strict';
const csrf = document.querySelector('meta[name=tilda-setup]').content;
const form = document.querySelector('#connect-form');
const field = document.querySelector('#token');
const button = document.querySelector('#connect');
const error = document.querySelector('#error');
let useSaved = false;
async function api(route, body) {
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Tilda-Setup': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
api('/api/status').then(data => {
  if (data.hasKey && !field.value) {
    useSaved = true;
    field.required = false;
    document.querySelector('#saved').hidden = false;
    document.querySelector('#new-key').hidden = true;
  }
}).catch(() => {});
document.querySelector('#replace-key').addEventListener('click', () => {
  useSaved = false;
  document.querySelector('#saved').hidden = true;
  document.querySelector('#new-key').hidden = false;
  field.required = true;
  field.focus();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  document.querySelector('#progress').hidden = false;
  const payload = { client: new FormData(form).get('client'), ...(useSaved ? { useSaved: true } : { token: field.value.trim() }) };
  field.value = '';
  try {
    const result = await api('/api/connect', payload);
    document.querySelector('#setup').hidden = true;
    document.querySelector('#restart').textContent = `Полностью закройте и откройте ${result.client}, затем начните новый чат.`;
    document.querySelector('#success').hidden = false;
    document.querySelector('#success').focus();
    window.scrollTo(0, 0);
  } catch (failure) {
    error.textContent = failure.message || 'Связь с мастером прервалась. Откройте Tilda Connect повторно.';
    error.hidden = false;
    if (!useSaved) field.focus();
  } finally {
    delete payload.token;
    button.disabled = false;
    document.querySelector('#progress').hidden = true;
  }
});
document.querySelector('#copy-prompt').addEventListener('click', async event => {
  const target = event.currentTarget;
  try { await navigator.clipboard.writeText('Покажи мои проекты в Tilda'); target.textContent = 'Скопировано'; }
  catch { target.textContent = 'Выделите и скопируйте фразу выше'; }
});
document.querySelector('#finish').addEventListener('click', async event => {
  const target = event.currentTarget;
  try { await api('/api/close', {}); } catch { /* The process may already be closed. */ }
  target.disabled = true;
  target.querySelector('span').textContent = 'Готово. Вкладку можно закрыть';
});
