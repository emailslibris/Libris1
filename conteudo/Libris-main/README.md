# Multimeios Digital

Sistema escolar de biblioteca da CREDE, feito com HTML, CSS e JavaScript. Os dados operacionais ficam no IndexedDB da máquina da biblioteca.

## Estado da arquitetura

O PWA usa IndexedDB para livros, leitores, empréstimos, configurações e auditoria. O login Google usa Firebase Authentication; o frontend não importa nem consulta Firestore. As operações do painel não enviam os dados da biblioteca a um banco remoto.

## Arquitetura desejada

- Cada escola usa um computador principal; não há sincronização entre máquinas.
- Na primeira abertura sem configuração, a primeira conta Google que entrar será a administradora Libris. Faça o primeiro login com a conta Libris no computador da escola.
- A conta Libris configura nome e emails autorizados. Essa configuração fica local no computador; a conta Libris não acessa livros, leitores nem empréstimos.
- O login é Google; emails fora da lista local não entram no painel escolar.
- O botão **Enviar backup semanal** envia um JSON ao Meu Drive da mesma conta escolar. Quando o backup vencer, é necessário abrir o app e clicar no botão; o navegador não garante upload com o PWA fechado.
- O botão **Restaurar JSON** aceita backups locais e o JSON da antiga Cloud Function.

Não apague o Firestore nem os backups legados antes de confirmar a migração e testar uma restauração no computador da escola.

## Configuração Firebase

1. No Firebase Console do projeto `librisce`, habilite **Authentication > Email/Password** e **Authentication > Google**. Adicione o domínio HTTPS publicado em **Authorized domains**.
2. Em **Authentication > Users**, crie `admin@crede17.ce.gov.br` com uma senha nova, forte e exclusiva. A senha digitada no app é validada pelo Firebase Authentication; ela não está no código. Como a senha anterior foi compartilhada em conversa, não a reutilize.
3. Ative a Google Drive API no Google Cloud do projeto. O app solicita o escopo `drive.file` somente quando alguém usa o botão de backup.
4. No computador da biblioteca, entre primeiro com `admin@crede17.ce.gov.br` e a senha criada no Firebase. Essa conta abre o painel de configuração Libris.
5. Cadastre o identificador e o nome da escola e os emails Google autorizados. Os dados ficam no IndexedDB daquele computador.

O login administrativo usa Firebase Authentication por email/senha. Os funcionários da escola entram com Google, e o app compara o email com a lista local autorizada. A função agendada antiga de backup continua no código de servidor e pode depender do Firestore; ela não é chamada pelo PWA.

## Migração de dados legados

Para trazer dados antigos, baixe um JSON produzido pela antiga `weeklySchoolDriveBackup` e use **Restaurar JSON** no painel escolar. A restauração valida o `schoolId`, preserva registros de outras escolas e substitui os dados locais da escola selecionada. Não há leitura automática do Firestore pelo app.

## Backup semanal no Google Drive

No painel escolar, clique em **Enviar backup semanal** quando o status indicar que está vencido. O arquivo vai para a raiz do Meu Drive da mesma conta Google autorizada no painel. O primeiro envio pede consentimento `drive.file`; a conta Libris não recebe esse escopo ao apenas configurar a escola.

O navegador só envia enquanto o app está aberto. Se a máquina ficar desligada ou o app fechado na data prevista, o backup fica pendente até a próxima abertura e ação do usuário. A antiga Cloud Function `weeklySchoolDriveBackup` continua sendo um mecanismo legado separado e ainda lê Firestore.

## Capas, sinopses e avisos por e-mail

Ao cadastrar um livro, o sistema busca automaticamente capa e descrição pelo título, autor e editora. A primeira fonte é o Google Books; se não houver resultado, ele tenta a Open Library. Se nenhuma fonte encontrar o livro, o cadastro continua normalmente sem esses dados.

Esta cópia PWA legada não envia e-mails. O envio SMTP está disponível apenas no aplicativo desktop Libris atual. Os avisos por WhatsApp continuam disponíveis. Para manter o contato da coordenação, configure `coordinationEmail` no documento da escola:

```json
{
  "name": "Nome da escola",
  "active": true,
  "bookSequences": {},
  "coordinationEmail": "coordenacao@escola.edu.br"
}
```

Não há envio automático de e-mails em segundo plano.

## Executar localmente

Gere os arquivos publicados e sirva a pasta `dist` por HTTP:

```sh
npm run build:hosting
python3 -m http.server 8080 --directory dist
```

Abra `http://localhost:8080` no Chromium. Não abra o HTML diretamente pelo gerenciador de arquivos: módulos JavaScript, Firebase e o service worker precisam de um servidor HTTP. O service worker guarda somente o shell estático; login e dados precisam de conexão e do backend atual.

## Instalar no Chromium/Xubuntu

1. Abra a URL HTTPS publicada ou `http://localhost:8080` no Chromium.
2. Use o ícone **Instalar Libris** na barra de endereço ou abra o menu do Chromium e escolha **Instalar Libris**.
3. Confirme a instalação. O Libris será aberto em uma janela própria e aparecerá no lançador de aplicativos.

Se a opção de instalação não aparecer, confira se o manifest, os ícones e o service worker estão acessíveis na mesma origem. Para instalação em outro computador ou celular, a origem precisa usar HTTPS; a exceção para HTTP vale somente para `localhost`.

## Publicar

Para publicar o shell estático fora do Firebase, use Cloudflare Pages conectado ao repositório:

1. Crie um projeto Pages e conecte este repositório.
2. Configure o comando de build como `npm run build:hosting` e o diretório de saída como `dist`.
3. Aguarde a URL HTTPS e teste o login e as funções do app antes de compartilhar o endereço.

O domínio HTTPS definitivo também deverá ser cadastrado nas origens autorizadas do OAuth quando a migração Google for implementada. Nunca coloque Client Secret, chave privada ou token de serviço no frontend.

O build copia onze arquivos necessários ao app: HTML, CSS, JavaScript, módulos de armazenamento local, configuração de autenticação/migração, imagem de marca, manifest, service worker e dois ícones. Scripts de migração, funções de servidor, chaves privadas e arquivos de desenvolvimento não são publicados.

## Limites atuais

- A autenticação ainda depende do Firebase Authentication com o provedor Google habilitado; não há Client Secret no frontend.
- A migração de dados existentes requer um JSON exportado do backup legado. O app não conecta ao Firestore.
- O backup Drive não roda com o navegador fechado. Verifique o status semanalmente no computador da biblioteca.
- A validação foi feita por testes de armazenamento e build; o login Google e o upload real ainda precisam ser testados no domínio autorizado, com Google Authentication e Drive API habilitados.
