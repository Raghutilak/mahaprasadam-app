import { useState } from "react";
import { supabaseAuth } from "../supabaseAuthClient";
import CustomerAuth from "./CustomerAuth";
import BookOrder from "./BookOrder";
import MyOrders from "./MyOrders";
import "./CustomerPortal.css";

// Guest checkout was removed: unauthenticated order submission was a soft
// spot for junk/abusive data with no account behind it to trace or rate-limit
// against. Every order now requires a real (email-verified) customer login.
export default function CustomerPortal({ session, onExit, onStaffLoginClick }) {
  const [tab, setTab] = useState("book");

  if (!session) {
    return <CustomerAuth onExit={onExit} onStaffLoginClick={onStaffLoginClick} />;
  }

  const customer = { email: session.user.email, mobile: session.user.user_metadata?.mobile || "" };

  return (
    <div className="customer-portal">
      <header className="page-header">
        <div>
          <h1>🍬 Book Order</h1>
          <p>{session.user.email}</p>
        </div>
        <button className="adjust-btn-ghost" onClick={() => supabaseAuth.auth.signOut()}>Log Out</button>
      </header>

      <div className="reports-subnav">
        <button className={tab === "book" ? "active" : ""} onClick={() => setTab("book")}>📦 Book Order</button>
        <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>🧾 My Orders</button>
      </div>

      {tab === "book" ? <BookOrder customer={customer} /> : <MyOrders />}

      {onStaffLoginClick && (
        <button type="button" className="staff-login-link" onClick={onStaffLoginClick}>🔒 Staff Login</button>
      )}
    </div>
  );
}
