export function normalizeIsbn(value) {
  return String(value ?? '')
    .trim()
    .replace(/^ISBN(?:-1[03])?\s*:?\s*/i, '')
    .replace(/[\s-]/g, '')
    .toUpperCase()
}

function isbn13CheckDigit(firstTwelveDigits) {
  const sum = [...firstTwelveDigits].reduce((total, digit, index) => {
    return total + Number(digit) * (index % 2 === 0 ? 1 : 3)
  }, 0)
  return String((10 - sum % 10) % 10)
}

export function isbnToEan13(value) {
  const isbn = normalizeIsbn(value)
  if (/^97[89]\d{10}$/.test(isbn) && isbn13CheckDigit(isbn.slice(0, 12)) === isbn[isbn.length - 1]) return isbn
  if (!/^\d{9}[\dX]$/.test(isbn)) return null

  const checksum = [...isbn].reduce((total, digit, index) => {
    return total + (digit === 'X' ? 10 : Number(digit)) * (10 - index)
  }, 0)
  if (checksum % 11 !== 0) return null

  const firstTwelveDigits = `978${isbn.slice(0, 9)}`
  return `${firstTwelveDigits}${isbn13CheckDigit(firstTwelveDigits)}`
}