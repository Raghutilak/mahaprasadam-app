import { useState } from "react";
import { supabaseAuth } from "../supabaseAuthClient";
import CustomerAuth from "./CustomerAuth";
import BookOrder from "./BookOrder";
import MyOrders from "./MyOrders";
import "./CustomerPortal.css";

export default function CustomerPortal({ session, onExit, onStaffLoginClick }) {
  const [tab, setTab] = useState("book");
  // Guests skip login entirely — once true, BookOrder collects their email/mobile itself.
  const [isGuest, setIsGuest] = useState(false);

  if (!session && !isGuest) {
    return <CustomerAuth onExit={onExit} onStaffLoginClick={onStaffLoginClick} onGuestContinue={() => setIsGuest(true)} />;
  }

  const customer = session ? { email: session.user.email, mobile: session.user.user_metadata?.mobile || "" } : { email: "", mobile: "" };

  return (
    <div className="customer-portal">
      <header className="page-header">
        <div>
          <h1>🍬 Book Order</h1>
          <p>{session ? session.user.email : "Booking as guest"}</p>
        </div>
        {session ? (
          <button className="adjust-btn-ghost" onClick={() => supabaseAuth.auth.signOut()}>Log Out</button>
        ) : (
          <button className="adjust-btn-ghost" onClick={() => setIsGuest(false)}>Log In Instead</button>
        )}
      </header>

      {/* Guests have no order history to look up (no account tied to their orders), so
          there's nothing useful for the "My Orders" tab to show them. */}
      {session && (
        <div className="reports-subnav">
          <button className={tab === "book" ? "active" : ""} onClick={() => setTab("book")}>📦 Book Order</button>
          <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>🧾 My Orders</button>
        </div>
      )}

      {(!session || tab === "book") ? <BookOrder customer={customer} isGuest={!session} /> : <MyOrders />}

      {onStaffLoginClick && (
        <button type="button" className="staff-login-link" onClick={onStaffLoginClick}>🔒 Staff Login</button>
      )}
    </div>
  );
}
