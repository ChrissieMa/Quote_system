export const attributionOwnerTransferScript = `<script>
(function () {
  var key = 'lks_owner_attribution_selection_v1';
  var codePattern = /^LKS-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;
  window.lksAttributionOwnerSelection = {
    remember: function (inquiry, code) {
      if (!inquiry || inquiry.length > 100 || !codePattern.test(code)) return;
      try {
        window.sessionStorage.setItem(key, JSON.stringify({ inquiry: inquiry, code: code, time: Date.now() }));
      } catch (_) { console.warn('Attribution selection could not be retained.'); }
    },
    take: function (inquiry) {
      try {
        var raw = window.sessionStorage.getItem(key);
        window.sessionStorage.removeItem(key);
        if (!raw) return '';
        var item = JSON.parse(raw);
        var age = Date.now() - item.time;
        if (item.inquiry !== inquiry || !codePattern.test(item.code) || !Number.isFinite(age) || age < 0 || age > 60000) return '';
        return item.code;
      } catch (_) {
        console.warn('Attribution selection could not be read.');
        return '';
      }
    }
  };
})();
</script>`;
