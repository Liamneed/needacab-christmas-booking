import { BudgetAPI } from "/js/api.js";

const form = document.querySelector("#budgetLoginForm");
if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const budgetNumber = form.budgetNumber.value.trim();
    const holderName   = form.holderName.value.trim();
    const pin          = form.pin.value.trim();

    try {
      await BudgetAPI.login(budgetNumber, holderName, pin);
      // Example: show current session
      const me = await BudgetAPI.me();
      console.log("Session:", me);
      // TODO: redirect to budget dashboard
      // window.location.href = "/budget-dashboard.html";
    } catch (err) {
      alert(err.message || "Login failed");
    }
  });
}
