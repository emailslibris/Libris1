# Memória do projeto Libris

## Visão geral

Esta cópia PWA legada foi mantida para referência. Ela não oferece envio de e-mail. O aplicativo desktop atual envia avisos manualmente por SMTP.

## E-mails no aplicativo desktop

- Os avisos ao leitor e à coordenação são enviados manualmente pelo administrador.
- A configuração SMTP pertence à escola e é associada ao `schoolId`.
- A senha de aplicativo fica no cofre de credenciais do sistema operacional, não no IndexedDB, Firestore ou backup.
- São usadas conexões TLS seguras nas portas 465 ou 587 com STARTTLS obrigatório.
- O histórico local mantém os 100 envios mais recentes por escola, sem guardar o corpo das mensagens.
- Não há envio automático em segundo plano.

## Dados locais e isolamento

Os dados operacionais permanecem no armazenamento local e são isolados por escola usando `schoolId`. Backups e restaurações mantêm essa separação. A senha SMTP nunca é exportada.

## Avisos

O usuário abre a notificação de um empréstimo e escolhe enviar manualmente um e-mail ao leitor ou à coordenação. O WhatsApp continua disponível na cópia PWA legada.
