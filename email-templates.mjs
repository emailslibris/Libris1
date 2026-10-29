const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[character])

const renderMessage = (message) => escapeHtml(message).replace(/\r\n|\r|\n/g, '<br>')

function emailFrame(subject, schoolName, subtitle, content) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#eef1f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef1f6;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #dde3ee;">
          <tr>
            <td style="background-color:#21681f;padding:26px 32px;">
              <div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:bold;color:#ffffff;">Biblioteca Escolar</div>
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#d4e4d3;margin-top:4px;">${escapeHtml(schoolName)}${subtitle}</div>
            </td>
          </tr>
          ${content}
          <tr>
            <td style="background-color:#f5f8fd;padding:18px 32px;border-top:1px solid #dde3ee;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#7a879f;text-align:center;">
              Mensagem enviada pelo sistema Libris · ${escapeHtml(schoolName)}.<br>
              Por favor, não responda a este e-mail.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export function createStudentEmailHtml({ subject, schoolName, message, bookTitle, dueDate, loanDays }) {
  const content = `
          <tr>
            <td style="padding:32px 32px 8px;font-family:Arial,Helvetica,sans-serif;color:#26324a;">
              <div style="font-size:16px;line-height:1.7;color:#3a4763;">${renderMessage(message)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f8fd;border-left:4px solid #26681f;border-radius:6px;">
                <tr>
                  <td style="padding:16px 18px;font-family:Arial,Helvetica,sans-serif;">
                    <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#7a879f;margin-bottom:4px;">Livro</div>
                    <div style="font-size:17px;font-weight:bold;color:#1f3a68;margin-bottom:12px;">${escapeHtml(bookTitle)}</div>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td width="50%" style="font-family:Arial,Helvetica,sans-serif;">
                          <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#7a879f;">Data de devolução</div>
                          <div style="font-size:15px;font-weight:bold;color:#26324a;margin-top:2px;">${escapeHtml(dueDate)}</div>
                        </td>
                        <td width="50%" style="font-family:Arial,Helvetica,sans-serif;">
                          <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#7a879f;">Prazo do empréstimo</div>
                          <div style="font-size:15px;font-weight:bold;color:#26324a;margin-top:2px;">${escapeHtml(loanDays)} dias</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 30px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#3a4763;">
              Para devolver ou renovar o livro, procure a biblioteca da <strong>${escapeHtml(schoolName)}</strong>. Se você já devolveu, desconsidere esta mensagem.
            </td>
          </tr>`
  return emailFrame(subject, schoolName, '', content)
}

export function createCoordinationEmailHtml({ subject, schoolName, message, readerName, bookTitle, dueDate, daysOverdue }) {
  const content = `
          <tr>
            <td style="background-color:#fff4e5;border-bottom:1px solid #f5d9a8;padding:12px 32px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#9a5b00;">
              &#9888; Livro em atraso: ${escapeHtml(daysOverdue)} dia(s)
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 8px;font-family:Arial,Helvetica,sans-serif;color:#26324a;">
              <div style="font-size:15px;line-height:1.65;color:#3a4763;">${renderMessage(message)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #dde3ee;border-radius:6px;border-collapse:separate;">
                <tr>
                  <td width="38%" style="padding:12px 16px;background-color:#f5f8fd;border-bottom:1px solid #dde3ee;font-family:Arial,Helvetica,sans-serif;font-size:12px;text-transform:uppercase;color:#7a879f;">Leitor</td>
                  <td style="padding:12px 16px;border-bottom:1px solid #dde3ee;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#26324a;">${escapeHtml(readerName)}</td>
                </tr>
                <tr>
                  <td width="38%" style="padding:12px 16px;background-color:#f5f8fd;border-bottom:1px solid #dde3ee;font-family:Arial,Helvetica,sans-serif;font-size:12px;text-transform:uppercase;color:#7a879f;">Livro</td>
                  <td style="padding:12px 16px;border-bottom:1px solid #dde3ee;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#1f3a68;">${escapeHtml(bookTitle)}</td>
                </tr>
                <tr>
                  <td width="38%" style="padding:12px 16px;background-color:#f5f8fd;font-family:Arial,Helvetica,sans-serif;font-size:12px;text-transform:uppercase;color:#7a879f;">Venceu em</td>
                  <td style="padding:12px 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#26324a;">${escapeHtml(dueDate)}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 30px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#3a4763;">
              Solicitamos que a coordenação entre em contato com o leitor para regularizar a devolução do livro.
            </td>
          </tr>`
  return emailFrame(subject, schoolName, ' · Aviso à coordenação', content)
}
