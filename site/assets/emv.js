/* EMVCo payload tools for DuitNow QR — JS port of the apps' duitnow_qr.dart.
   A static DuitNow payload (tag 01 = "11") carries no amount; re-issuing it
   as dynamic (tag 01 = "12") with tag 54 set locks the amount in the
   customer's banking app. CRC is CRC-16/CCITT-FALSE (tag 63).
   Verified against the shop's Public Bank merchant QR (CHOP NG KIM HUAT). */
function emvParse(payload) {
  if (!payload || payload.length < 12) return null;
  var out = [], i = 0;
  while (i < payload.length) {
    if (i + 4 > payload.length) return null;
    var tag = payload.substr(i, 2);
    var len = parseInt(payload.substr(i + 2, 2), 10);
    if (isNaN(len) || i + 4 + len > payload.length) return null;
    out.push([tag, payload.substr(i + 4, len)]);
    i += 4 + len;
  }
  return out;
}
function emvCrc16(data) {
  var crc = 0xFFFF;
  for (var k = 0; k < data.length; k++) {
    crc ^= (data.charCodeAt(k) << 8) & 0xFFFF;
    for (var b = 0; b < 8; b++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return ('000' + crc.toString(16).toUpperCase()).slice(-4);
}
function emvIsValid(payload) {
  var tags = emvParse(payload);
  if (!tags || !tags.length || tags[tags.length - 1][0] !== '63') return false;
  return emvCrc16(payload.slice(0, -4)) === payload.slice(-4);
}
function emvTag(payload, tag) {
  var tags = emvParse(payload);
  if (!tags) return null;
  for (var k = 0; k < tags.length; k++) if (tags[k][0] === tag) return tags[k][1];
  return null;
}
function emvBuildDynamic(payload, amountCents) {
  if (!amountCents || amountCents <= 0) return null;
  if (!emvIsValid(payload)) return null;
  var tags = emvParse(payload);
  var amount = (amountCents / 100).toFixed(2);
  var out = '', wrote = false;
  for (var k = 0; k < tags.length; k++) {
    var tag = tags[k][0], value = tags[k][1];
    if (tag === '63') continue;
    if (tag === '01') value = '12';
    if (tag === '54') { value = amount; wrote = true; }
    out += tag + ('0' + value.length).slice(-2) + value;
    if (tag === '53' && !wrote) {
      out += '54' + ('0' + amount.length).slice(-2) + amount;
      wrote = true;
    }
  }
  if (!wrote) return null;
  var body = out + '6304';
  return body + emvCrc16(body);
}
/* Renders a QR for `text` as an SVG string (uses the vendored
   qrcode-generator library, global `qrcode`). */
function qrSvg(text, cellSize) {
  var qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag(cellSize || 6, 12);
}
