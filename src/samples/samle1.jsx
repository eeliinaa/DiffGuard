import React, { useEffect, useState } from "react";

export default function UserProfile({ userId, isAdmin }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);

  const getUserData = async () => {
    setLoading(true);

    try {
      const response = await fetch(`/api/user/${userId}`);
      const data = await response.json();

      setUser(data);
    } catch (err) {
      console.error("Failed to load user", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (userId) {
      getUserData();
    }
  }, [userId]);

  const handleUpdateClick = () => {
    if (!isAdmin) {
      alert("You are not allowed to update this user");
      return;
    }

    console.log("Updating user...");
  };

  if (loading) {
    return <div>Loading user...</div>;
  }

  if (!user) {
    return <div>No user found</div>;
  }

  return (
    <div className="user-profile">
      <h1>{user.name}</h1>

      <p>Email: {user.email}</p>
      <p>Role: {user.role}</p>

      {isAdmin && (
        <button onClick={handleUpdateClick}>
          Update User
        </button>
      )}
    </div>
  );
}