// Reception guides: one per screen, in English or Bahasa Indonesia, behind the "?" in the header.
// Only points at what is on the screen and explains it: the tour blocks every tap, so nothing
// is ever recorded. A step about something not on the screen right now (no damage today…) is left out.
import { startTour, onScreen } from './tour.js';

const $ = s => document.querySelector(s);
// The card whose heading starts with this text (sections have no ids of their own).
const sec = h => () => [...document.querySelectorAll('#main section.card')].find(c => (c.querySelector('h2')?.textContent || '').trim().startsWith(h)) || null;
const parentOf = s => () => $(s)?.parentElement || null;

// [element, title EN, text EN, title ID, text ID]
const HEAD = [
  ['#sync', 'Connection', 'Green = everything is in the sheet. During an Internet cut keep working: everything is kept on this computer and sent by itself later.',
    'Koneksi', 'Hijau = semua sudah di sheet. Saat internet mati, tetap bekerja: semua disimpan di komputer ini dan dikirim otomatis nanti.'],
  ['.card.shift .figures', 'Cash of this shift', 'Cash at the opening, cash in and out since then, and what *should be in the box* now.',
    'Kas shift ini', 'Kas saat buka, uang masuk dan keluar sejak itu, dan berapa yang *seharusnya ada di kotak* sekarang.'],
  ['nav.tabs', 'The screens', 'One tab per job. A number on a tab = something waiting there. Each screen has its own guide: press *?* on it.',
    'Layar-layar', 'Satu tab untuk satu pekerjaan. Angka di tab = ada yang menunggu. Setiap layar punya panduan sendiri: tekan *?* di layar itu.'],
  ['#refreshBtn', 'Refresh', 'Just changed something in Beds24? Press *Refresh*: Beds24 and the sheet are read again now.',
    'Refresh', 'Baru mengubah sesuatu di Beds24? Tekan *Refresh*: Beds24 dan sheet dibaca ulang sekarang.'],
];

const SCREENS = {
  open: {
    en: 'Open the shift', id: 'Buka shift',
    steps: [
      [null, 'Start of your shift', 'Before anything else, count the cash box and open your shift. Every sale and expense goes into the shift that is open.',
        'Awal shift Anda', 'Sebelum yang lain, hitung kotak kas dan buka shift Anda. Semua penjualan dan pengeluaran masuk ke shift yang sedang buka.'],
      ['.figure', 'Last recorded', 'The cash the box should have, from the last shift that was closed.',
        'Terakhir tercatat', 'Uang yang seharusnya ada di kotak, dari shift terakhir yang ditutup.'],
      ['#cash', 'Count and type', 'Count the cash really in the box and type it. The difference with the last recorded amount shows right under it.',
        'Hitung dan ketik', 'Hitung uang yang benar-benar ada di kotak dan ketik. Selisih dengan jumlah terakhir muncul di bawahnya.'],
      ['#comment', 'Comment', 'A difference? Say why here (for example: change given to the bar).',
        'Komentar', 'Ada selisih? Tulis alasannya di sini (misalnya: kembalian diberikan ke bar).'],
      ['#openForm button.primary', 'Open my shift', 'Then *Open my shift*. Works without Internet too.',
        'Buka shift saya', 'Lalu *Open my shift*. Bisa juga tanpa internet.'],
    ],
  },
  sell: {
    en: 'Sell', id: 'Sell (Jual)',
    steps: [
      [null, 'Sell', 'Everything a guest buys is recorded here: services, transport, tours, masks and bikes.',
        'Sell (Jual)', 'Semua yang dibeli tamu dicatat di sini: layanan, transport, tur, masker dan sepeda.'],
      ...HEAD,
      ['#guestIn', '1. The guest', 'Type the first letters of the name and pick the guest. A guest not in Beds24 (walk-in)? Pick *New guest*. You can add several guests to the same sale.',
        '1. Tamu', 'Ketik huruf pertama nama dan pilih tamunya. Tamu tidak ada di Beds24 (walk-in)? Pilih *New guest*. Bisa beberapa tamu dalam satu penjualan.'],
      ['#prodIn', '2. The products', 'Tap a product to add it, tap again for one more. Search here when the list is long.',
        '2. Produk', 'Sentuh produk untuk menambah, sentuh lagi untuk satu lagi. Cari di sini kalau daftarnya panjang.'],
      ['#cart', '3. The sale', 'What you added. *−* / *+* changes the quantity, × removes a line. The price can be changed when needed.\nSnorkeling mask or bike: type or pick its *number* (SG…, B…). Qty = number of days.',
        '3. Penjualan', 'Yang sudah ditambahkan. *−* / *+* mengubah jumlah, × menghapus baris. Harga bisa diubah kalau perlu.\nMasker snorkeling atau sepeda: ketik atau pilih *nomornya* (SG…, B…). Jumlah = jumlah hari.'],
      [parentOf('[data-pay]'), '4. How the guest pays', '*Cash*, *Card*, *Transfer*.\n*Unpaid* = the guest pays later: it goes on the guest’s bill (Guest bills).\n*Paid to Partner* = the guest paid the partner directly.',
        '4. Cara tamu membayar', '*Cash*, *Card*, *Transfer*.\n*Unpaid* = tamu bayar nanti: masuk ke tagihan tamu (Guest bills).\n*Paid to Partner* = tamu sudah bayar langsung ke partner.'],
      ['#saleComment', 'Comment', 'Anything useful to know later (time of the shuttle, special price…).',
        'Komentar', 'Informasi yang berguna nanti (jam shuttle, harga khusus…).'],
      ['#recordSale', '5. Record sale', 'Records the sale. Without Internet it waits on this computer and is sent by itself. A mistake? Fix it in *This shift*.',
        '5. Record sale', 'Mencatat penjualan. Tanpa internet, menunggu di komputer ini dan dikirim otomatis. Salah? Perbaiki di *This shift*.'],
      ['[data-sellview="comm"]', 'Commissions', 'See the commissions of this period, and give a tour to the colleague who really sold it.',
        'Komisi', 'Lihat komisi periode ini, dan berikan tur ke rekan yang benar-benar menjualnya.'],
      ['[data-sellview="acts"]', 'Tours & transport', 'Change the name, price or cost of a tour or transport, or add a new one.',
        'Tur & transport', 'Ubah nama, harga atau biaya tur atau transport, atau tambah yang baru.'],
    ],
  },
  sellcomm: {
    en: 'Commissions', id: 'Komisi',
    steps: [
      [null, 'Commissions', 'Each sale pays its seller *20% of its margin* (price − cost).',
        'Komisi', 'Setiap penjualan memberi penjualnya *20% dari margin* (harga − biaya).'],
      ['.extra h2 + p', 'Whose and when', 'The lines of this period (not marked Past in the sheet).',
        'Milik siapa dan kapan', 'Baris-baris periode ini (yang tidak bertanda Past di sheet).'],
      ['[data-give]', 'Give to…', 'A tour or transport sold by a colleague but recorded by you? *Give to…* moves it to them. The sheet emails the change.',
        'Give to…', 'Tur atau transport dijual rekan tapi Anda yang mencatat? *Give to…* memindahkannya ke rekan itu. Sheet mengirim email perubahannya.'],
      ['.extrahead .help', 'The rules', 'All the rules are here: point at the *?*.',
        'Aturan', 'Semua aturan ada di sini: arahkan ke *?*.'],
      ['[data-sellback]', 'Back to Sell', 'Back to the sale screen.', 'Kembali ke Sell', 'Kembali ke layar penjualan.'],
    ],
  },
  sellacts: {
    en: 'Tours & transport', id: 'Tur & transport',
    steps: [
      [null, 'Tours & transport', 'The tours and transports sold in Sell, from the sheet. A change here is a change for everybody.',
        'Tur & transport', 'Tur dan transport yang dijual di Sell, dari sheet. Perubahan di sini berlaku untuk semua orang.'],
      ['.alist', 'The list', 'Name, price to the guest, cost (what we pay the partner) and margin.',
        'Daftar', 'Nama, harga untuk tamu, biaya (yang kita bayar ke partner) dan margin.'],
      ['[data-actedit]', 'Edit', 'Change the name, price or cost. Every change is kept with the old values.',
        'Edit', 'Ubah nama, harga atau biaya. Setiap perubahan disimpan bersama nilai lamanya.'],
      ['[data-actadd]', 'Add', 'A new tour or transport.', 'Tambah', 'Tur atau transport baru.'],
      ['[data-sellback]', 'Back to Sell', 'Back to the sale screen.', 'Kembali ke Sell', 'Kembali ke layar penjualan.'],
    ],
  },
  bills: {
    en: 'Guest bills', id: 'Tagihan tamu',
    steps: [
      [null, 'Guest bills', 'What guests still have to pay: *Unpaid* sales and room nights not paid yet in Beds24.',
        'Tagihan tamu', 'Yang masih harus dibayar tamu: penjualan *Unpaid* dan malam kamar yang belum dibayar di Beds24.'],
      ['#billQ', 'Find a guest', 'Type a name to find the guest.', 'Cari tamu', 'Ketik nama untuk mencari tamu.'],
      ['ul.glist', 'Open bills', 'Every guest who owes something, with the amount. Tap a guest to see and collect the bill.',
        'Tagihan terbuka', 'Setiap tamu yang punya utang, dengan jumlahnya. Sentuh tamu untuk melihat dan menerima pembayaran.'],
      ['[data-newguest]', '+ New guest', 'A guest not in Beds24 (walk-in, food, Sunset Boat…): create them here, then sell in Sell.',
        '+ New guest', 'Tamu yang tidak ada di Beds24 (walk-in, makanan, Sunset Boat…): buat di sini, lalu jual di Sell.'],
      ['.helprow .help', 'Rules with Beds24', 'New night or extension → always in Beds24.\nGuest pays right away → record it in Beds24 only.\nGuest pays later → here only.\n*Never change a payment in Beds24*: fix it here.',
        'Aturan dengan Beds24', 'Malam baru atau perpanjangan → selalu di Beds24.\nTamu langsung bayar → catat di Beds24 saja.\nTamu bayar nanti → di sini saja.\n*Jangan pernah mengubah pembayaran di Beds24*: perbaiki di sini.'],
    ],
  },
  bill: {
    en: 'A guest’s bill', id: 'Tagihan seorang tamu',
    steps: [
      [null, 'The bill of one guest', 'Everything this guest still has to pay.', 'Tagihan satu tamu', 'Semua yang masih harus dibayar tamu ini.'],
      ['#payForm h3', 'Tick what is paid now', 'Tick the lines the guest pays now. All of them, or only some.',
        'Centang yang dibayar sekarang', 'Centang baris yang dibayar tamu sekarang. Semua, atau hanya sebagian.'],
      [parentOf('[data-bpay]'), 'How', 'Choose how the guest pays.', 'Cara bayar', 'Pilih cara tamu membayar.'],
      ['#payForm button.primary', 'Record payment', 'Records the payment. Room payments go to Beds24 by themselves: *never record them in Beds24 too*.',
        'Record payment', 'Mencatat pembayaran. Pembayaran kamar masuk ke Beds24 otomatis: *jangan dicatat lagi di Beds24*.'],
      ['[data-back]', 'All bills', 'Back to the list of guests.', 'Semua tagihan', 'Kembali ke daftar tamu.'],
    ],
  },
  expenses: {
    en: 'Expenses', id: 'Pengeluaran',
    steps: [
      [null, 'Expenses', 'Money paid out for the hotel: restaurant, maintenance, cleaning, laundry…',
        'Pengeluaran', 'Uang yang dibayar untuk hotel: restoran, perawatan, kebersihan, laundry…'],
      [parentOf('[data-item]'), 'What for', 'Pick what it is for. *Others* = anything else (say what in the comment).',
        'Untuk apa', 'Pilih untuk apa. *Others* = lainnya (tulis apa di komentar).'],
      ['#expAmount', 'Amount', 'The amount paid.', 'Jumlah', 'Jumlah yang dibayar.'],
      [parentOf('[data-epay]'), 'Paid with', '*Cash* from the box, *Card*, *Transfer*, or *Unpaid* (we pay later).',
        'Dibayar dengan', '*Cash* dari kotak, *Card*, *Transfer*, atau *Unpaid* (kita bayar nanti).'],
      ['#expDate', 'Date', 'Today by default. Change it only for an expense of another day.', 'Tanggal', 'Hari ini otomatis. Ubah hanya untuk pengeluaran hari lain.'],
      ['#expComment', 'Comment', 'What exactly, and for whom.', 'Komentar', 'Apa tepatnya, dan untuk siapa.'],
      ['#expForm button.primary', 'Record expense', 'Records it. Cash expenses lower what should be in the box.',
        'Record expense', 'Mencatatnya. Pengeluaran cash mengurangi uang yang seharusnya ada di kotak.'],
      [sec('Expenses in this shift'), 'In this shift', 'Your expenses of this shift. A mistake? Edit or delete it here while your shift is open.',
        'Di shift ini', 'Pengeluaran Anda di shift ini. Salah? Edit atau hapus di sini selama shift Anda masih buka.'],
    ],
  },
  cash: {
    en: 'Cash box', id: 'Kotak kas',
    steps: [
      [null, 'Cash box', 'Money in the box that is not a sale or an expense: *phantom cash* and *cash supply*.',
        'Kotak kas', 'Uang di kotak yang bukan penjualan atau pengeluaran: *phantom cash* dan *cash supply*.'],
      ['[data-kind="given"]', 'Cash not given', 'Change we still owe someone: the money is in the box but is not ours.',
        'Cash not given', 'Kembalian yang masih kita utang ke seseorang: uangnya di kotak tapi bukan milik kita.'],
      ['[data-kind="received"]', 'Cash not received', 'Money someone still owes us: it is missing from the box.',
        'Cash not received', 'Uang yang masih diutang seseorang ke kita: tidak ada di kotak.'],
      ['#phComment', 'Who and why', 'Always say who and why (for example: change for Elias, room 3).',
        'Siapa dan kenapa', 'Selalu tulis siapa dan kenapa (misalnya: kembalian untuk Elias, kamar 3).'],
      [sec('Cash supply'), 'Cash supply', 'Cash brought to the desk from outside, for change. A mistake: a manager deletes it and records it again.',
        'Cash supply', 'Uang yang dibawa ke resepsi dari luar, untuk kembalian. Salah: manajer menghapus dan mencatat ulang.'],
      [sec('Not solved yet'), 'Not solved yet', 'Phantom cash still open. When the money is given or received, press *Solved*.',
        'Belum selesai', 'Phantom cash yang masih terbuka. Kalau uangnya sudah diberikan atau diterima, tekan *Solved*.'],
    ],
  },
  partners: {
    en: 'Partners', id: 'Partner',
    steps: [
      [null, 'Partners', 'Tours and transport done by partners: we bill them together, then record the payment.',
        'Partner', 'Tur dan transport oleh partner: kita buat tagihannya bersama, lalu catat pembayarannya.'],
      ['.plist', '1. Choose a partner', 'A number on a partner = sales not billed yet. Tap it.',
        '1. Pilih partner', 'Angka di partner = penjualan yang belum ditagih. Sentuh partnernya.'],
      [() => sec('Choose a partner')() || [...document.querySelectorAll('#main section.card')].find(c => /not billed yet/.test(c.querySelector('h2')?.textContent || '')) || null, '2. The sales to bill', 'Tick the sales to put on the bill, check the *cost*, then *Create bill*. Tap other partners to put them on the same bill.',
        '2. Penjualan untuk ditagih', 'Centang penjualan untuk tagihan, cek *cost*-nya, lalu *Create bill*. Sentuh partner lain untuk memasukkannya ke tagihan yang sama.'],
      [sec('Bills waiting for payment'), '3. Bills waiting for payment', 'Open a bill: *Paid…* when the money is paid or received, *Print* to give it to the partner, *Delete bill* if it is wrong.',
        '3. Tagihan menunggu pembayaran', 'Buka tagihan: *Paid…* kalau uangnya sudah dibayar atau diterima, *Print* untuk diberikan ke partner, *Delete bill* kalau salah.'],
    ],
  },
  card: {
    en: 'Card', id: 'Kartu',
    steps: [
      [null, 'Card terminal settlement', 'Once a day, settle the card terminal, then type what it printed here.',
        'Settlement mesin kartu', 'Sekali sehari, lakukan settlement di mesin kartu, lalu ketik hasil cetaknya di sini.'],
      ['#cs1', 'Settlement 1', 'The total printed by the terminal.', 'Settlement 1', 'Total yang dicetak mesin.'],
      ['#cs2', 'Settlement 2', 'Only if the terminal printed a second settlement.', 'Settlement 2', 'Hanya jika mesin mencetak settlement kedua.'],
      ['#clocal', 'Local cards', 'Local cards have no 3% fee: type their total and name the guests in the comment.',
        'Kartu lokal', 'Kartu lokal tidak kena biaya 3%: ketik totalnya dan tulis nama tamunya di komentar.'],
      ['#cardForm button.primary', 'Send settlement', 'The sheet compares with the card payments recorded. A big difference sends an alert to the managers.',
        'Send settlement', 'Sheet membandingkan dengan pembayaran kartu yang tercatat. Selisih besar mengirim peringatan ke manajer.'],
      [sec('Card payments since then'), 'Card payments since then', 'The card payments recorded since the last settlement: they should match the terminal.',
        'Pembayaran kartu sejak itu', 'Pembayaran kartu yang tercatat sejak settlement terakhir: harus sama dengan mesin.'],
    ],
  },
  bar: {
    en: 'Bar cash-out', id: 'Bar cash-out',
    steps: [
      [null, 'Bar cash-out', 'Cash taken out of the bar cash at the end of the day.', 'Bar cash-out', 'Uang yang diambil dari kas bar di akhir hari.'],
      ['#barAmount', 'Amount', 'The amount taken out of the bar.', 'Jumlah', 'Jumlah yang diambil dari bar.'],
      ['#barForm button.primary', 'Record', 'Records the cash-out.', 'Catat', 'Mencatat cash-out.'],
      [sec('Last bar cash-outs'), 'Last two weeks', 'The cash-outs of the last two weeks.', 'Dua minggu terakhir', 'Cash-out dua minggu terakhir.'],
    ],
  },
  gear: {
    en: 'Gear', id: 'Gear',
    steps: [
      [null, 'Masks and bikes', 'Where each snorkeling mask and bike is. A rental is recorded in *Sell* with its number.',
        'Masker dan sepeda', 'Posisi setiap masker snorkeling dan sepeda. Penyewaan dicatat di *Sell* dengan nomornya.'],
      [sec('Out now'), 'Out now', 'What is out, with whom and until when. Late = red. A WhatsApp button reminds the guest.',
        'Sedang keluar', 'Yang sedang keluar, dengan siapa dan sampai kapan. Terlambat = merah. Tombol WhatsApp mengingatkan tamu.'],
      [sec('Return'), 'Return', 'A guest brings a mask or bike back to the desk: type or pick its number, check its condition, *Record return*. A late return shows how late, with *Waive it* first.',
        'Pengembalian', 'Tamu mengembalikan masker atau sepeda ke resepsi: ketik atau pilih nomornya, cek kondisinya, *Record return*. Pengembalian terlambat menunjukkan berapa lama, dengan *Waive it* di depan.'],
      [sec('Volunteer'), 'Volunteer', 'A free outing without a sale (a volunteer): record which numbers go out.',
        'Volunteer', 'Pemakaian gratis tanpa penjualan (volunteer): catat nomor yang keluar.'],
      [sec('Differences to solve together'), 'Differences', 'What the gear staff counted does not match the records. Check it with them: each side confirms, then it closes. *Checked · all* closes many at once.',
        'Selisih', 'Hitungan staf gear tidak cocok dengan catatan. Cek bersama mereka: masing-masing konfirmasi, lalu selisih tertutup. *Checked · all* menutup banyak sekaligus.'],
      [sec('Status of masks'), 'Status of masks & bikes', 'Broken ones cannot be rented. Repaired? *Repaired · back in stock*. Tap a number to mark it broken or missing a part. The gear staff can do the same in their app (*Kondisi barang*).',
        'Kondisi masker & sepeda', 'Yang rusak tidak bisa disewa. Sudah diperbaiki? *Repaired · back in stock*. Sentuh nomor untuk menandai rusak atau ada bagian hilang. Staf gear bisa melakukan hal yang sama di aplikasinya (*Kondisi barang*).'],
      [sec('Damage to decide'), 'Damage to decide', 'Broken or missing part: charge the guest (an Unpaid line on their bill), don’t charge, or keep it for later.',
        'Kerusakan', 'Rusak atau ada bagian hilang: tagih tamu (baris Unpaid di tagihannya), tidak ditagih, atau putuskan nanti.'],
      [sec('Evening check'), 'Evening check', 'Every evening around 20:00 the gear staff count everything in their app (*Cek malam*). Not done = reminder here.',
        'Cek malam', 'Setiap malam sekitar jam 20:00 staf gear menghitung semuanya di aplikasi mereka (*Cek malam*). Belum dilakukan = pengingat di sini.'],
    ],
  },
  shift: {
    en: 'This shift', id: 'Shift ini',
    steps: [
      [null, 'This shift', 'Everything recorded in this shift, and where to fix a mistake.', 'Shift ini', 'Semua yang dicatat di shift ini, dan tempat memperbaiki kesalahan.'],
      ['.split', 'Totals', 'Sales and money paid out, by way of payment.', 'Total', 'Penjualan dan uang keluar, per cara pembayaran.'],
      ['.shiftfilter', 'Filter', 'Show only the lines paid in cash, by card…', 'Filter', 'Tampilkan hanya baris yang dibayar cash, kartu…'],
      [() => document.querySelector('[data-edit], [data-del]')?.closest('li') || null, 'Fix a line', '*Edit*, *Delete* or *Refund* a line you recorded yourself, while your shift is open. A manager can fix any line.',
        'Perbaiki baris', '*Edit*, *Delete* atau *Refund* baris yang Anda catat sendiri, selama shift Anda masih buka. Manajer bisa memperbaiki semua baris.'],
    ],
  },
  close: {
    en: 'Close shift', id: 'Tutup shift',
    steps: [
      [null, 'End of your shift', 'Count the cash box and close your shift. Needs Internet: without it, keep working and close when it is back.',
        'Akhir shift Anda', 'Hitung kotak kas dan tutup shift Anda. Perlu internet: kalau tidak ada, tetap bekerja dan tutup saat internet kembali.'],
      ['#closeForm .phwarn', 'Before closing', 'Warnings to read first (evening check not done, phantom cash of this shift…).',
        'Sebelum menutup', 'Peringatan yang harus dibaca dulu (cek malam belum dilakukan, phantom cash shift ini…).'],
      ['#cash', 'Cash counted', 'All the cash really in the box, *before* taking anything out.', 'Uang dihitung', 'Semua uang yang benar-benar ada di kotak, *sebelum* mengambil apa pun.'],
      ['#cashout', 'Cash taken out', 'Money you remove from the box and hand over. Empty if none.', 'Uang diambil', 'Uang yang Anda ambil dari kotak dan serahkan. Kosongkan jika tidak ada.'],
      ['#comment', 'Comment', 'A difference? Say why.', 'Komentar', 'Ada selisih? Tulis alasannya.'],
      ['#closeForm button.primary', 'Review and close', 'Shows the difference, then *Close shift* to confirm. Nothing is closed before that.',
        'Review and close', 'Menampilkan selisih, lalu *Close shift* untuk konfirmasi. Belum ada yang ditutup sebelum itu.'],
    ],
  },
  closing: {
    en: 'Close shift', id: 'Tutup shift',
    steps: [
      ['.confirm .figures', 'Check the numbers', 'Counted, taken out, and the difference with what should be in the box.',
        'Cek angkanya', 'Dihitung, diambil, dan selisih dengan yang seharusnya ada di kotak.'],
      ['#confirmClose', 'Close shift', 'Closes the shift for good.', 'Close shift', 'Menutup shift secara permanen.'],
      ['#cancelClose', 'Change the numbers', 'Back to the form to correct.', 'Ubah angka', 'Kembali ke formulir untuk memperbaiki.'],
    ],
  },
};

const END = ['#who [data-help]', 'Done', 'Press *?* on any screen for its own guide.', 'Selesai', 'Tekan *?* di layar mana pun untuk panduannya.'];

export const deskScreenName = (key, lang) => (SCREENS[key] || SCREENS.sell)[lang === 'id' ? 'id' : 'en'];

export function startDeskTour(key, lang, onEnd) {
  const s = SCREENS[key] || SCREENS.sell;
  const id = lang === 'id';
  // Nothing to point at (no damage today, no commission line…): that step is left out.
  const steps = [...s.steps, END].filter(([el]) => !el || onScreen(el))
    .map(([el, te, xe, ti, xi]) => ({ el: el || undefined, title: id ? ti : te, text: id ? xi : xe }));
  startTour(steps, {
    labels: id ? { next: 'Lanjut ›', back: '‹ Kembali', done: 'Selesai', close: 'Tutup', of: 'dari' } : { next: 'Next ›', back: '‹ Back', done: 'Finish', close: 'Close', of: 'of' },
    onEnd,
  });
}
